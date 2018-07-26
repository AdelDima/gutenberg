/**
 * External dependencies
 */
import { BEGIN, COMMIT, REVERT } from 'redux-optimist';
import { get, includes, last, map, castArray, uniqueId, pick } from 'lodash';

/**
 * WordPress dependencies
 */
import {
	parse,
	getBlockType,
	switchToBlockType,
	createBlock,
	serialize,
	isReusableBlock,
	getDefaultBlockForPostFormat,
	doBlocksMatchTemplate,
	synchronizeBlocksWithTemplate,
} from '@wordpress/blocks';
import { __ } from '@wordpress/i18n';
import { speak } from '@wordpress/a11y';
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import {
	setupEditorState,
	resetAutosave,
	resetPost,
	updatePost,
	receiveBlocks,
	receiveReusableBlocks,
	replaceBlock,
	replaceBlocks,
	createSuccessNotice,
	createErrorNotice,
	createWarningNotice,
	removeNotice,
	saveReusableBlock,
	insertBlock,
	removeBlocks,
	selectBlock,
	removeBlock,
	resetBlocks,
	setTemplateValidity,
} from './actions';
import {
	getCurrentPost,
	getCurrentPostType,
	getEditedPostContent,
	getPostEdits,
	isEditedPostAutosaveable,
	isEditedPostSaveable,
	getBlock,
	getBlockCount,
	getBlockRootClientId,
	getBlocks,
	getReusableBlock,
	getPreviousBlockClientId,
	getProvisionalBlockClientId,
	getSelectedBlock,
	isBlockSelected,
	getTemplate,
	getTemplateLock,
	getAutosave,
	isEditedPostNew,
	POST_UPDATE_TRANSACTION_ID,
} from './selectors';

/**
 * Module Constants
 */
const SAVE_POST_NOTICE_ID = 'SAVE_POST_NOTICE_ID';
const AUTOSAVE_POST_NOTICE_ID = 'AUTOSAVE_POST_NOTICE_ID';
const TRASH_POST_NOTICE_ID = 'TRASH_POST_NOTICE_ID';
const REUSABLE_BLOCK_NOTICE_ID = 'REUSABLE_BLOCK_NOTICE_ID';

/**
 * Effect handler returning an action to remove the provisional block, if one
 * is set.
 *
 * @param {Object} action Action object.
 * @param {Object} store  Data store instance.
 *
 * @return {?Object} Remove action, if provisional block is set.
 */
export function removeProvisionalBlock( action, store ) {
	const state = store.getState();
	const provisionalBlockClientId = getProvisionalBlockClientId( state );
	if ( provisionalBlockClientId && ! isBlockSelected( state, provisionalBlockClientId ) ) {
		return removeBlock( provisionalBlockClientId, false );
	}
}

export default {
	REQUEST_POST_UPDATE( action, store ) {
		const { dispatch, getState } = store;
		const state = getState();
		const post = getCurrentPost( state );
		const isAutosave = !! action.options.autosave;

		// Prevent save if not saveable.
		const isSaveable = isAutosave ? isEditedPostAutosaveable : isEditedPostSaveable;
		if ( ! isSaveable( state ) ) {
			return;
		}

		let edits = getPostEdits( state );
		if ( isAutosave ) {
			edits = pick( edits, [ 'title', 'content', 'excerpt' ] );
		}

		// New posts (with auto-draft status) must be explicitly assigned draft
		// status if there is not already a status assigned in edits (publish).
		// Otherwise, they are wrongly left as auto-draft. Status is not always
		// respected for autosaves, so it cannot simply be included in the pick
		// above. This behavior relies on an assumption that an auto-draft post
		// would never be saved by anyone other than the owner of the post, per
		// logic within autosaves REST controller to save status field only for
		// draft/auto-draft by current user.
		//
		// See: https://core.trac.wordpress.org/ticket/43316#comment:88
		// See: https://core.trac.wordpress.org/ticket/43316#comment:89
		if ( isEditedPostNew( state ) ) {
			edits = { status: 'draft', ...edits };
		}

		let toSend = {
			...edits,
			content: getEditedPostContent( state ),
			id: post.id,
		};
		const basePath = wp.api.getPostTypeRoute( getCurrentPostType( state ) );

		dispatch( {
			type: 'REQUEST_POST_UPDATE_START',
			optimist: { type: BEGIN, id: POST_UPDATE_TRANSACTION_ID },
			isAutosave,
		} );

		// Optimistically apply updates under the assumption that the post
		// will be updated. See below logic in success resolution for revert
		// if the autosave is applied as a revision.
		dispatch( {
			...updatePost( toSend ),
			optimist: { id: POST_UPDATE_TRANSACTION_ID },
		} );

		let request;
		if ( isAutosave ) {
			// Ensure autosaves contain all expected fields, using autosave or
			// post values as fallback if not otherwise included in edits.
			toSend = {
				...pick( post, [ 'title', 'content', 'excerpt' ] ),
				...getAutosave( state ),
				...toSend,
				parent: post.id,
			};

			request = apiFetch( {
				path: `/wp/v2/${ basePath }/${ post.id }/autosaves`,
				method: 'POST',
				data: toSend,
			} );
		} else {
			dispatch( removeNotice( SAVE_POST_NOTICE_ID ) );
			dispatch( removeNotice( AUTOSAVE_POST_NOTICE_ID ) );

			request = apiFetch( {
				path: `/wp/v2/${ basePath }/${ post.id }`,
				method: 'PUT',
				data: toSend,
			} );
		}

		request
			.then( ( newPost ) => {
				const reset = isAutosave ? resetAutosave : resetPost;
				dispatch( reset( newPost ) );

				// An autosave may be processed by the server as a regular save
				// when its update is requested by the author and the post was
				// draft or auto-draft.
				const isRevision = newPost.id !== post.id;

				dispatch( {
					type: 'REQUEST_POST_UPDATE_SUCCESS',
					previousPost: post,
					post: newPost,
					optimist: {
						// Note: REVERT is not a failure case here. Rather, it
						// is simply reversing the assumption that the updates
						// were applied to the post proper, such that the post
						// treated as having unsaved changes.
						type: isRevision ? REVERT : COMMIT,
						id: POST_UPDATE_TRANSACTION_ID,
					},
					isAutosave,
				} );
			} )
			.catch( ( error ) => dispatch( {
				type: 'REQUEST_POST_UPDATE_FAILURE',
				optimist: { type: REVERT, id: POST_UPDATE_TRANSACTION_ID },
				post,
				edits,
				error,
			} ) );
	},
	REQUEST_POST_UPDATE_SUCCESS( action, store ) {
		const { previousPost, post, isAutosave } = action;
		const { dispatch, getState } = store;

		// TEMPORARY: If edits remain after a save completes, the user must be
		// prompted about unsaved changes. This should be refactored as part of
		// the `isEditedPostDirty` selector instead.
		//
		// See: https://github.com/WordPress/gutenberg/issues/7409
		if ( Object.keys( getPostEdits( getState() ) ).length ) {
			dispatch( { type: 'DIRTY_ARTIFICIALLY' } );
		}

		// Autosaves are neither shown a notice nor redirected.
		if ( isAutosave ) {
			return;
		}

		const publishStatus = [ 'publish', 'private', 'future' ];
		const isPublished = includes( publishStatus, previousPost.status );
		const willPublish = includes( publishStatus, post.status );

		let noticeMessage;
		let shouldShowLink = true;

		if ( ! isPublished && ! willPublish ) {
			// If saving a non-published post, don't show notice.
			noticeMessage = null;
		} else if ( isPublished && ! willPublish ) {
			// If undoing publish status, show specific notice
			noticeMessage = __( 'Post reverted to draft.' );
			shouldShowLink = false;
		} else if ( ! isPublished && willPublish ) {
			// If publishing or scheduling a post, show the corresponding
			// publish message
			noticeMessage = {
				publish: __( 'Post published!' ),
				private: __( 'Post published privately!' ),
				future: __( 'Post scheduled!' ),
			}[ post.status ];
		} else {
			// Generic fallback notice
			noticeMessage = __( 'Post updated!' );
		}

		if ( noticeMessage ) {
			dispatch( createSuccessNotice(
				<p>
					{ noticeMessage }
					{ ' ' }
					{ shouldShowLink && <a href={ post.link }>{ __( 'View post' ) }</a> }
				</p>,
				{ id: SAVE_POST_NOTICE_ID, spokenMessage: noticeMessage }
			) );
		}
	},
	REQUEST_POST_UPDATE_FAILURE( action, store ) {
		const { post, edits, error } = action;

		if ( error && 'rest_autosave_no_changes' === error.code ) {
			// Autosave requested a new autosave, but there were no changes. This shouldn't
			// result in an error notice for the user.
			return;
		}

		const { dispatch } = store;

		const publishStatus = [ 'publish', 'private', 'future' ];
		const isPublished = publishStatus.indexOf( post.status ) !== -1;
		// If the post was being published, we show the corresponding publish error message
		// Unless we publish an "updating failed" message
		const messages = {
			publish: __( 'Publishing failed' ),
			private: __( 'Publishing failed' ),
			future: __( 'Scheduling failed' ),
		};
		const noticeMessage = ! isPublished && publishStatus.indexOf( edits.status ) !== -1 ?
			messages[ edits.status ] :
			__( 'Updating failed' );
		dispatch( createErrorNotice( noticeMessage, { id: SAVE_POST_NOTICE_ID } ) );
	},
	TRASH_POST( action, store ) {
		const { dispatch, getState } = store;
		const { postId } = action;
		const basePath = wp.api.getPostTypeRoute( getCurrentPostType( getState() ) );
		dispatch( removeNotice( TRASH_POST_NOTICE_ID ) );
		apiFetch( { path: `/wp/v2/${ basePath }/${ postId }`, method: 'DELETE' } )
			.then( () => {
				const post = getCurrentPost( getState() );

				// TODO: This should be an updatePost action (updating subsets of post properties),
				// But right now editPost is tied with change detection.
				dispatch( resetPost( { ...post, status: 'trash' } ) );
			} )
			.catch( ( error ) => dispatch( {
				...action,
				type: 'TRASH_POST_FAILURE',
				error,
			} ) );
	},
	TRASH_POST_FAILURE( action, store ) {
		const message = action.error.message && action.error.code !== 'unknown_error' ? action.error.message : __( 'Trashing failed' );
		store.dispatch( createErrorNotice( message, { id: TRASH_POST_NOTICE_ID } ) );
	},
	REFRESH_POST( action, store ) {
		const { dispatch, getState } = store;

		const state = getState();
		const post = getCurrentPost( state );
		const basePath = wp.api.getPostTypeRoute( getCurrentPostType( state ) );

		const data = {
			context: 'edit',
		};

		apiFetch( { path: `/wp/v2/${ basePath }/${ post.id }`, data } ).then(
			( newPost ) => {
				dispatch( resetPost( newPost ) );
			}
		);
	},
	MERGE_BLOCKS( action, store ) {
		const { dispatch } = store;
		const state = store.getState();
		const [ firstBlockClientId, secondBlockClientId ] = action.blocks;
		const blockA = getBlock( state, firstBlockClientId );
		const blockB = getBlock( state, secondBlockClientId );
		const blockType = getBlockType( blockA.name );

		// Only focus the previous block if it's not mergeable
		if ( ! blockType.merge ) {
			dispatch( selectBlock( blockA.clientId ) );
			return;
		}

		// We can only merge blocks with similar types
		// thus, we transform the block to merge first
		const blocksWithTheSameType = blockA.name === blockB.name ?
			[ blockB ] :
			switchToBlockType( blockB, blockA.name );

		// If the block types can not match, do nothing
		if ( ! blocksWithTheSameType || ! blocksWithTheSameType.length ) {
			return;
		}

		// Calling the merge to update the attributes and remove the block to be merged
		const updatedAttributes = blockType.merge(
			blockA.attributes,
			blocksWithTheSameType[ 0 ].attributes
		);

		dispatch( selectBlock( blockA.clientId, -1 ) );
		dispatch( replaceBlocks(
			[ blockA.clientId, blockB.clientId ],
			[
				{
					...blockA,
					attributes: {
						...blockA.attributes,
						...updatedAttributes,
					},
				},
				...blocksWithTheSameType.slice( 1 ),
			]
		) );
	},
	SETUP_EDITOR( action, { getState } ) {
		const { post, autosave } = action;
		const state = getState();
		const template = getTemplate( state );
		const templateLock = getTemplateLock( state );

		// Parse content as blocks
		let blocks;
		let isValidTemplate = true;
		if ( post.content.raw ) {
			blocks = parse( post.content.raw );

			// Unlocked templates are considered always valid because they act as default values only.
			isValidTemplate = (
				! template ||
				templateLock !== 'all' ||
				doBlocksMatchTemplate( blocks, template )
			);
		} else if ( template ) {
			blocks = synchronizeBlocksWithTemplate( [], template );
		} else if ( getDefaultBlockForPostFormat( post.format ) ) {
			blocks = [ createBlock( getDefaultBlockForPostFormat( post.format ) ) ];
		} else {
			blocks = [];
		}

		// Include auto draft title in edits while not flagging post as dirty
		const edits = {};
		if ( post.status === 'auto-draft' ) {
			edits.title = post.title.raw;
		}

		// Check the auto-save status
		let autosaveAction;
		if ( autosave ) {
			const noticeMessage = __( 'There is an autosave of this post that is more recent than the version below.' );
			autosaveAction = createWarningNotice(
				<p>
					{ noticeMessage }
					{ ' ' }
					<a href={ autosave.editLink }>{ __( 'View the autosave' ) }</a>
				</p>,
				{
					id: AUTOSAVE_POST_NOTICE_ID,
					spokenMessage: noticeMessage,
				}
			);
		}

		return [
			setTemplateValidity( isValidTemplate ),
			setupEditorState( post, blocks, edits ),
			...( autosaveAction ? [ autosaveAction ] : [] ),
		];
	},
	SYNCHRONIZE_TEMPLATE( action, { getState } ) {
		const state = getState();
		const blocks = getBlocks( state );
		const template = getTemplate( state );
		const updatedBlockList = synchronizeBlocksWithTemplate( blocks, template );

		return [
			resetBlocks( updatedBlockList ),
			setTemplateValidity( true ),
		];
	},
	CHECK_TEMPLATE_VALIDITY( action, { getState } ) {
		const state = getState();
		const blocks = getBlocks( state );
		const template = getTemplate( state );
		const templateLock = getTemplateLock( state );
		const isValid = (
			! template ||
			templateLock !== 'all' ||
			doBlocksMatchTemplate( blocks, template )
		);

		return setTemplateValidity( isValid );
	},
	FETCH_REUSABLE_BLOCKS( action, store ) {
		// TODO: these are potentially undefined, this fix is in place
		// until there is a filter to not use reusable blocks if undefined
		const basePath = wp.api.getPostTypeRoute( 'wp_block' );
		if ( ! basePath ) {
			return;
		}

		const { id } = action;
		const { dispatch } = store;

		let result;
		if ( id ) {
			result = apiFetch( { path: `/wp/v2/${ basePath }/${ id }` } );
		} else {
			result = apiFetch( { path: `/wp/v2/${ basePath }?per_page=-1` } );
		}

		result
			.then( ( reusableBlockOrBlocks ) => {
				dispatch( receiveReusableBlocks( map(
					castArray( reusableBlockOrBlocks ),
					( reusableBlock ) => ( {
						reusableBlock,
						parsedBlock: parse( reusableBlock.content )[ 0 ],
					} )
				) ) );

				dispatch( {
					type: 'FETCH_REUSABLE_BLOCKS_SUCCESS',
					id,
				} );
			} )
			.catch( ( error ) => dispatch( {
				type: 'FETCH_REUSABLE_BLOCKS_FAILURE',
				id,
				error,
			} ) );
	},
	RECEIVE_REUSABLE_BLOCKS( action ) {
		return receiveBlocks( map( action.results, 'parsedBlock' ) );
	},
	SAVE_REUSABLE_BLOCK( action, store ) {
		// TODO: these are potentially undefined, this fix is in place
		// until there is a filter to not use reusable blocks if undefined
		const basePath = wp.api.getPostTypeRoute( 'wp_block' );
		if ( ! basePath ) {
			return;
		}

		const { id } = action;
		const { dispatch } = store;
		const state = store.getState();

		const { clientId, title, isTemporary } = getReusableBlock( state, id );
		const { name, attributes, innerBlocks } = getBlock( state, clientId );
		const content = serialize( createBlock( name, attributes, innerBlocks ) );

		const data = isTemporary ? { title, content } : { id, title, content };
		const path = isTemporary ? `/wp/v2/${ basePath }` : `/wp/v2/${ basePath }/${ id }`;
		const method = isTemporary ? 'POST' : 'PUT';

		apiFetch( { path, data, method } )
			.then( ( updatedReusableBlock ) => {
				dispatch( {
					type: 'SAVE_REUSABLE_BLOCK_SUCCESS',
					updatedId: updatedReusableBlock.id,
					id,
				} );
				const message = isTemporary ? __( 'Block created.' ) : __( 'Block updated.' );
				dispatch( createSuccessNotice( message, { id: REUSABLE_BLOCK_NOTICE_ID } ) );
			} )
			.catch( ( error ) => {
				dispatch( { type: 'SAVE_REUSABLE_BLOCK_FAILURE', id } );
				dispatch( createErrorNotice( error.message, {
					id: REUSABLE_BLOCK_NOTICE_ID,
					spokenMessage: error.message,
				} ) );
			} );
	},
	DELETE_REUSABLE_BLOCK( action, store ) {
		// TODO: these are potentially undefined, this fix is in place
		// until there is a filter to not use reusable blocks if undefined
		const basePath = wp.api.getPostTypeRoute( 'wp_block' );
		if ( ! basePath ) {
			return;
		}

		const { id } = action;
		const { getState, dispatch } = store;

		// Don't allow a reusable block with a temporary ID to be deleted
		const reusableBlock = getReusableBlock( getState(), id );
		if ( ! reusableBlock || reusableBlock.isTemporary ) {
			return;
		}

		// Remove any other blocks that reference this reusable block
		const allBlocks = getBlocks( getState() );
		const associatedBlocks = allBlocks.filter( ( block ) => isReusableBlock( block ) && block.attributes.ref === id );
		const associatedBlockClientIds = associatedBlocks.map( ( block ) => block.clientId );

		const transactionId = uniqueId();

		dispatch( {
			type: 'REMOVE_REUSABLE_BLOCK',
			id,
			optimist: { type: BEGIN, id: transactionId },
		} );

		// Remove the parsed block.
		dispatch( removeBlocks( [
			...associatedBlockClientIds,
			reusableBlock.clientId,
		] ) );

		apiFetch( { path: `/wp/v2/${ basePath }/${ id }`, method: 'DELETE' } )
			.then( () => {
				dispatch( {
					type: 'DELETE_REUSABLE_BLOCK_SUCCESS',
					id,
					optimist: { type: COMMIT, id: transactionId },
				} );
				const message = __( 'Block deleted.' );
				dispatch( createSuccessNotice( message, { id: REUSABLE_BLOCK_NOTICE_ID } ) );
			} )
			.catch( ( error ) => {
				dispatch( {
					type: 'DELETE_REUSABLE_BLOCK_FAILURE',
					id,
					optimist: { type: REVERT, id: transactionId },
				} );
				dispatch( createErrorNotice( error.message, {
					id: REUSABLE_BLOCK_NOTICE_ID,
					spokenMessage: error.message,
				} ) );
			} );
	},
	CONVERT_BLOCK_TO_STATIC( action, store ) {
		const state = store.getState();
		const oldBlock = getBlock( state, action.clientId );
		const reusableBlock = getReusableBlock( state, oldBlock.attributes.ref );
		const referencedBlock = getBlock( state, reusableBlock.clientId );
		const newBlock = createBlock( referencedBlock.name, referencedBlock.attributes );
		store.dispatch( replaceBlock( oldBlock.clientId, newBlock ) );
	},
	CONVERT_BLOCK_TO_REUSABLE( action, store ) {
		const { getState, dispatch } = store;

		const parsedBlock = getBlock( getState(), action.clientId );
		const reusableBlock = {
			id: uniqueId( 'reusable' ),
			clientId: parsedBlock.clientId,
			title: __( 'Untitled reusable block' ),
		};

		dispatch( receiveReusableBlocks( [ {
			reusableBlock,
			parsedBlock,
		} ] ) );

		dispatch( saveReusableBlock( reusableBlock.id ) );

		dispatch( replaceBlock(
			parsedBlock.clientId,
			createBlock( 'core/block', {
				ref: reusableBlock.id,
				layout: parsedBlock.attributes.layout,
			} )
		) );

		// Re-add the original block to the store, since replaceBlock() will have removed it
		dispatch( receiveBlocks( [ parsedBlock ] ) );
	},
	CREATE_NOTICE( { notice: { content, spokenMessage } } ) {
		const message = spokenMessage || content;
		speak( message, 'assertive' );
	},

	EDIT_POST( action, { getState } ) {
		const format = get( action, [ 'edits', 'format' ] );
		if ( ! format ) {
			return;
		}
		const blockName = getDefaultBlockForPostFormat( format );
		if ( blockName && getBlockCount( getState() ) === 0 ) {
			return insertBlock( createBlock( blockName ) );
		}
	},

	CLEAR_SELECTED_BLOCK: removeProvisionalBlock,

	SELECT_BLOCK: removeProvisionalBlock,

	MULTI_SELECT: removeProvisionalBlock,

	REMOVE_BLOCKS( action, { getState, dispatch } ) {
		// if the action says previous block should not be selected don't do anything.
		if ( ! action.selectPrevious ) {
			return;
		}

		const firstRemovedBlockClientId = action.clientIds[ 0 ];
		const state = getState();
		const currentSelectedBlock = getSelectedBlock( state );

		// recreate the state before the block was removed.
		const previousState = { ...state, editor: { present: last( state.editor.past ) } };

		// rootClientId of the removed block.
		const rootClientId = getBlockRootClientId( previousState, firstRemovedBlockClientId );

		// Client ID of the block that was before the removed block or the
		// rootClientId if the removed block was first amongst its siblings.
		const blockClientIdToSelect = getPreviousBlockClientId( previousState, firstRemovedBlockClientId ) || rootClientId;

		// Dispatch select block action if the currently selected block
		// is not already the block we want to be selected.
		if ( blockClientIdToSelect !== currentSelectedBlock ) {
			dispatch( selectBlock( blockClientIdToSelect ) );
		}
	},
};
