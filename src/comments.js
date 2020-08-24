const Apify = require('apify');
const { getCheckedVariable, log, filterPushedItemsAndUpdateState, finiteScroll } = require('./helpers');
const { PAGE_TYPES, GRAPHQL_ENDPOINT, LOG_TYPES } = require('./consts');
const errors = require('./errors');

const initData = {};

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * correct list of comments.
 * @param {Object} data GraphQL data
 */
const getCommentsFromGraphQL = ({ data }) => {
    let shortcode_media;
    // TODO remove this garbage :)
    if (data.data) {
        log(itemSpec, 'HAD NESTED DATA', LOG_TYPES.WARNING)
        shortcode_media = data.data.shortcode_media;
    } else {
        shortcode_media = data.shortcode_media;
    }
    const timeline = shortcode_media && shortcode_media.edge_media_to_parent_comment;
    const commentItems = timeline ? timeline.edges.reverse() : [];
    const commentsCount = timeline ? timeline.count : null;
    const hasNextPage = timeline ? timeline.page_info.has_next_page : false;
    return { comments: commentItems, hasNextPage, commentsCount };
};

/**
 * Loads data from entry date and then loads comments untill limit is reached
 * @param {Object} page Puppeteer Page object
 * @param {Object} request Apify Request object
 * @param {Object} itemSpec Parsed page data
 * @param {Object} entryData data from window._shared_data.entry_data
 */
const scrapeComments = async ({ page, itemSpec, entryData, scrollingState, puppeteerPool }) => {
    // Check that current page is of a type which has comments
    if (itemSpec.pageType !== PAGE_TYPES.POST) throw errors.notPostPage();

    // Check if the page loaded properly
    const el = await page.$('.EtaWk');
    if (!el) {
        throw new Error(`Post page didn't load properly, opening again`);
    }

    const timeline = getCommentsFromGraphQL({ data: entryData.PostPage[0].graphql });
    initData[itemSpec.id] = timeline;

    // We want to push as soon as we have the data. We have to persist comment ids state so we don;t loose those on migration
    if (initData[itemSpec.id]) {
        const commentsReadyToPush = await filterPushedItemsAndUpdateState({
            items: timeline.comments,
            itemSpec,
            parsingFn: parseCommentsForOutput,
            scrollingState,
        });
        log(page.itemSpec, `${timeline.comments.length} comments loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.commentsCount} comments scraped`);

        await Apify.pushData(commentsReadyToPush);
    } else {
        log(itemSpec, 'Waiting for initial data to load');
        while (!initData[itemSpec.id]) await page.waitFor(100);
    }

    await page.waitFor(500);

    const willContinueScroll = initData[itemSpec.id].hasNextPage && Object.keys(scrollingState[itemSpec.id].ids).length < itemSpec.limit;
    if (willContinueScroll) {
        // await page.waitFor(1000);
        await finiteScroll({
            itemSpec,
            page,
            scrollingState,
            getItemsFromGraphQLFn: getCommentsFromGraphQL,
            type: 'comments',
            puppeteerPool,
        });
    }
};

/**
 * Takes GraphQL response, checks that it's a response with more comments and then parses the comments from it
 * @param {Object} page Puppeteer Page object
 * @param {Object} response Puppeteer Response object
 */
async function handleCommentsGraphQLResponse({ page, response, scrollingState, limit }) {
    const responseUrl = response.url();

    // Get variable we look for in the query string of request
    const checkedVariable = getCheckedVariable(page.itemSpec.pageType);

    // Skip queries for other stuff then posts
    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) return;

    const data = await response.json();
    const timeline = getCommentsFromGraphQL({ data: data.data });

    if (!initData[page.itemSpec.id]) {
        initData[page.itemSpec.id] = timeline;
    } else if (initData[page.itemSpec.id].hasNextPage && !timeline.hasNextPage) {
        initData[page.itemSpec.id].hasNextPage = false;
    }

    const commentsReadyToPush = await filterPushedItemsAndUpdateState({
        items: timeline.comments,
        itemSpec: page.itemSpec,
        parsingFn: parseCommentsForOutput,
        scrollingState,
        limit,
    });
    log(page.itemSpec, `${timeline.comments.length} comments loaded, ${Object.keys(scrollingState[page.itemSpec.id].ids).length}/${timeline.commentsCount} comments scraped`);
    await Apify.pushData(commentsReadyToPush);
}

function parseCommentsForOutput (comments, itemSpec, currentScrollingPosition) {
    return comments.map((item, index) => ({
        '#debug': {
            index: index + currentScrollingPosition + 1,
            // ...Apify.utils.createRequestDebugInfo(request),
            ...itemSpec,
        },
        id: item.node.id,
        postId: itemSpec.id,
        text: item.node.text,
        position: index + currentScrollingPosition + 1,
        timestamp: new Date(parseInt(item.node.created_at, 10) * 1000),
        ownerId: item.node.owner ? item.node.owner.id : null,
        ownerIsVerified: item.node.owner ? item.node.owner.is_verified : null,
        ownerUsername: item.node.owner ? item.node.owner.username : null,
        ownerProfilePicUrl: item.node.owner ? item.node.owner.profile_pic_url : null,
    }))
}

module.exports = {
    scrapeComments,
    handleCommentsGraphQLResponse,
};
