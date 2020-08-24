const Apify = require('apify');
const { getCheckedVariable, log, finiteScroll, filterPushedItemsAndUpdateState, shouldContinueScrolling } = require('./helpers');
const { PAGE_TYPES, LOG_TYPES } = require('./consts');
const { formatSinglePost } = require('./details');

const initData = {};

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * correct list of posts based on the page type.
 * @param {String} pageType Type of page we are scraping posts from
 * @param {Object} data GraphQL data
 */
const getPostsFromGraphQL = ({ pageType, data }) => {
    let timeline;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            timeline = data.location.edge_location_to_media;
            break;
        case PAGE_TYPES.PROFILE:
            timeline = data && data.user && data.user.edge_owner_to_timeline_media;
            break;
        case PAGE_TYPES.HASHTAG:
            timeline = data.hashtag.edge_hashtag_to_media;
            break;
        default: throw new Error('Not supported');
    }
    const postItems = timeline ? timeline.edges : [];
    const hasNextPage = timeline ? timeline.page_info.has_next_page : false;
    const postsCount = timeline ? timeline.count : null;
    return { posts: postItems, hasNextPage, postsCount };
};

/**
 * Takes type of page and it's initial loaded data and outputs
 * correct list of posts based on the page type.
 * @param {String} pageType Type of page we are scraping posts from
 * @param {Object} data GraphQL data
 */
const getPostsFromEntryData = (pageType, data) => {
    let pageData;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            pageData = data.LocationsPage;
            break;
        case PAGE_TYPES.PROFILE:
            pageData = data.ProfilePage;
            break;
        case PAGE_TYPES.HASHTAG:
            pageData = data.TagPage;
            break;
        default: throw new Error('Not supported');
    }
    if (!pageData || !pageData.length) return null;

    return getPostsFromGraphQL({ pageType, data: pageData[0].graphql });
};

const scrapePost = (request, itemSpec, entryData) => {
    const item = entryData.PostPage[0].graphql.shortcode_media;

    return {
        '#debug': {
            ...Apify.utils.createRequestDebugInfo(request),
            ...itemSpec,
            shortcode: item.shortcode,
            postLocationId: (item.location && item.location.id) || null,
            postOwnerId: (item.owner && item.owner.id) || null,
        },
        alt: item.accessibility_caption,
        url: `https://www.instagram.com/p/${item.shortcode}`,
        likesCount: item.edge_media_preview_like.count,
        imageUrl: item.display_url,
        firstComment: item.edge_media_to_caption.edges[0] && item.edge_media_to_caption.edges[0].node.text,
        timestamp: new Date(parseInt(item.taken_at_timestamp, 10) * 1000),
        locationName: (item.location && item.location.name) || null,
        ownerUsername: (item.owner && item.owner.username) || null,
    };
};

/**
 * Takes data from entry data and from loaded xhr requests and parses them into final output.
 * @param {Object} page Puppeteer Page object
 * @param {Object} request Apify Request object
 * @param {Object} itemSpec Parsed page data
 * @param {Object} entryData data from window._shared_data.entry_data
 * @param {Object} input Input provided by user
 */
const scrapePosts = async ({ page, itemSpec, entryData, scrollingState, puppeteerPool }) => {
    const timeline = getPostsFromEntryData(itemSpec.pageType, entryData);
    initData[itemSpec.id] = timeline;

    // Check if the posts loaded properly
    if (itemSpec.pageType === PAGE_TYPES.PROFILE) {
        const profilePageSel = '.ySN3v';
        const el = await page.$(`${profilePageSel}`);
        if (!el) {
            log(itemSpec, `Profile page didn't load properly, trying again...`, LOG_TYPES.ERROR);
            throw new Error(`Profile page didn't load properly, trying again...`);
        }
        const privatePageSel = '.rkEop';
        const elPrivate = await page.$(`${privatePageSel}`);
        if (elPrivate) {
            log(itemSpec, 'Profile is private exiting..', LOG_TYPES.ERROR);
            return;
        }
    }

    if (itemSpec.pageType === PAGE_TYPES.PLACE || itemSpec.pageType === PAGE_TYPES.HASHTAG) {
        const el = await page.$('.EZdmt');
        if (!el) {
            log(itemSpec, `Place/location or hashtag page didn't load properly, trying again...`, LOG_TYPES.ERROR);
            throw new Error(`Place/location or hashtag page didn't load properly, trying again...`);
        }
    }

    if (initData[itemSpec.id]) {
        const postsReadyToPush = await filterPushedItemsAndUpdateState({
            items: timeline.posts,
            itemSpec,
            parsingFn: parsePostsForOutput,
            scrollingState,
            type: 'posts',
            page,
        });
        // We save last date for the option to specify how far into the past we should scroll
        if (postsReadyToPush.length > 0) {
            scrollingState[itemSpec.id].lastPostDate = postsReadyToPush[postsReadyToPush.length - 1].timestamp;
        }

        log(page.itemSpec, `${timeline.posts.length} posts loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.postsCount} posts scraped`);
        await Apify.pushData(postsReadyToPush);
    } else {
        log(itemSpec, 'Waiting for initial data to load');
        while (!initData[itemSpec.id]) await page.waitFor(100);
    }

    await page.waitFor(500);

    const hasMostRecentPostsOnHashtagPage = itemSpec.pageType === PAGE_TYPES.HASHTAG
        ? await page.evaluate(() => document.querySelector('article > h2') !== null
        && document.querySelector('article > h2').textContent === 'Most recent')
        : true;

    // Places/locations don't allow scrolling without login
    const isUnloggedPlace = itemSpec.pageType === PAGE_TYPES.PLACE && !itemSpec.input.loginCookies;
    if (isUnloggedPlace) {
        log(itemSpec, `Place/location pages allow scrolling only under login, collecting initial posts and finishing`, LOG_TYPES.WARNING);
        await puppeteerPool.retire(page.browser());
        return;
    }

    const hasNextPage = initData[itemSpec.id].hasNextPage && hasMostRecentPostsOnHashtagPage;
    if (hasNextPage) {
        const shouldContinue = shouldContinueScrolling({ itemSpec, scrollingState, oldItemCount: 0, type: 'posts' });
        if (shouldContinue) {
            await page.waitFor(1000);
            await finiteScroll({
                itemSpec,
                page,
                scrollingState,
                getItemsFromGraphQLFn: getPostsFromGraphQL,
                type: 'posts',
                puppeteerPool,
            });
        }
    } else {
        // We have to forcefully close the browser here because it hangs sometimes for some listeners reasons
        // Because we always have max one page per browser, this is fine
        await puppeteerPool.retire(page.browser());
        return;
    }
};

/**
 * Catches GraphQL responses and if they contain post data, it stores the data
 * to the global variable.
 * @param {Object} page Puppeteer Page object
 * @param {Object} response Puppeteer Response object
 */
async function handlePostsGraphQLResponse({ page, response, scrollingState }) {
    const responseUrl = response.url();

    const { itemSpec } = page;

    // Get variable we look for in the query string of request
    const checkedVariable = getCheckedVariable(itemSpec.pageType);

    // Skip queries for other stuff then posts
    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) return;

    // If it fails here, it means that the error was caught in the finite scroll anyway so we just don't do anything
    let data;
    try {
        data = await response.json();
    } catch (e) {
        return;
    }
    const timeline = getPostsFromGraphQL({ pageType: itemSpec.pageType, data: data.data });

    if (!initData[itemSpec.id]) initData[itemSpec.id] = timeline;
    else if (initData[itemSpec.id].hasNextPage && !timeline.hasNextPage) {
        initData[itemSpec.id].hasNextPage = false;
    }

    const postsReadyToPush = await filterPushedItemsAndUpdateState({
        items: timeline.posts,
        itemSpec,
        parsingFn: parsePostsForOutput,
        scrollingState,
        type: 'posts',
        page,
    });
    // We save last date for the option to specify how far into the past we should scroll
    if (postsReadyToPush.length > 0) {
        scrollingState[itemSpec.id].lastPostDate = postsReadyToPush[postsReadyToPush.length - 1].timestamp;
    }

    log(itemSpec, `${timeline.posts.length} posts loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.postsCount} posts scraped`);
    await Apify.pushData(postsReadyToPush);
}

function parsePostsForOutput (posts, itemSpec, currentScrollingPosition) {
    return posts.map((item, index) => ({
        '#debug': {
            ...itemSpec,
            shortcode: item.node.shortcode,
            postLocationId: (item.node.location && item.node.location.id) || null,
            postOwnerId: (item.node.owner && item.node.owner.id) || null,
        },
        queryTag: itemSpec.tagName,
        queryUsername: itemSpec.userUsername,
        queryLocation: itemSpec.locationName,
        position: currentScrollingPosition + 1 + index,
        ...formatSinglePost(item.node),
    }))
}

module.exports = {
    scrapePost,
    scrapePosts,
    handlePostsGraphQLResponse,
};
