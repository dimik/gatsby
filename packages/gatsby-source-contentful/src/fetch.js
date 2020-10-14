const contentful = require(`contentful`)
const _ = require(`lodash`)
const chalk = require(`chalk`)
const { formatPluginOptionsForCLI } = require(`./plugin-options`)
const { makeContentfulReporter, CODES } = require(`./report`)

module.exports = async function contentfulFetch({
  syncToken,
  pluginConfig,
  reporter,
}) {
  const contentfulReporter = makeContentfulReporter(reporter)

  // Fetch articles.
  const pageLimit = pluginConfig.get(`pageLimit`)
  const contentfulClientOptions = {
    space: pluginConfig.get(`spaceId`),
    accessToken: pluginConfig.get(`accessToken`),
    host: pluginConfig.get(`host`),
    environment: pluginConfig.get(`environment`),
    proxy: pluginConfig.get(`proxy`),
  }

  const client = contentful.createClient(contentfulClientOptions)

  // The sync API puts the locale in all fields in this format { fieldName:
  // {'locale': value} } so we need to get the space and its default local.
  //
  // We'll extend this soon to support multiple locales.
  let space
  let locales
  let defaultLocale = `en-US`
  try {
    contentfulReporter.verbose(`Fetching default locale`)
    space = await client.getSpace()
    let contentfulLocales = await client
      .getLocales()
      .then(response => response.items)
    defaultLocale = _.find(contentfulLocales, { default: true }).code
    locales = contentfulLocales.filter(pluginConfig.get(`localeFilter`))
    if (locales.length === 0) {
      contentfulReporter.panic(
        `Please check if your localeFilter is configured properly. Locales '${_.join(
          contentfulLocales.map(item => item.code),
          `,`
        )}' were found but were filtered down to none.`,
        { code: CODES.LocalesMissing }
      )
    }
    contentfulReporter.verbose(`Default locale is: ${defaultLocale}`)
  } catch (e) {
    let details
    let errors
    if (e.code === `ENOTFOUND`) {
      details = `You seem to be offline`
    } else if (e.code === `SELF_SIGNED_CERT_IN_CHAIN`) {
      contentfulReporter.panic(
        `We couldn't make a secure connection to your contentful space. Please check if you have any self-signed SSL certificates installed.`,
        { code: CODES.SelfSignedCertificate, err: e }
      )
    } else if (e.response) {
      if (e.response.status === 404) {
        // host and space used to generate url
        details = `Endpoint not found. Check if ${chalk.yellow(
          `host`
        )} and ${chalk.yellow(`spaceId`)} settings are correct`
        errors = {
          host: `Check if setting is correct`,
          spaceId: `Check if setting is correct`,
        }
      } else if (e.response.status === 401) {
        // authorization error
        details = `Authorization error. Check if ${chalk.yellow(
          `accessToken`
        )} and ${chalk.yellow(`environment`)} are correct`
        errors = {
          accessToken: `Check if setting is correct`,
          environment: `Check if setting is correct`,
        }
      }
    }

    contentfulReporter.panic(`Accessing your Contentful space failed.
Try setting GATSBY_CONTENTFUL_OFFLINE=true to see if we can serve from cache.
${details ? `\n${details}\n` : ``}
Used options:
${formatPluginOptionsForCLI(pluginConfig.getOriginalPluginOptions(), errors)}`)
  }

  let currentSyncData
  const basicSyncConfig = {
    limit: pageLimit,
    resolveLinks: false,
  }
  try {
    let query = syncToken
      ? { nextSyncToken: syncToken, ...basicSyncConfig }
      : { initial: true, ...basicSyncConfig }
    currentSyncData = await client.sync(query)
  } catch (e) {
    contentfulReporter.panic(`Fetching contentful data failed`, {
      err: e,
      code: CODES.SyncError,
    })
  }

  // We need to fetch content types with the non-sync API as the sync API
  // doesn't support this.
  let contentTypes
  try {
    contentTypes = await pagedGet(client, `getContentTypes`, pageLimit)
  } catch (e) {
    contentfulReporter.panic(`error fetching content types`, {
      error: e,
      code: CODES.FetchContentTypes,
    })
  }
  contentfulReporter.verbose(
    `Content types fetched ${contentTypes.items.length}`
  )

  let contentTypeItems = contentTypes.items

  const result = {
    currentSyncData,
    contentTypeItems,
    defaultLocale,
    locales,
    space,
  }

  return result
}

/**
 * Gets all the existing entities based on pagination parameters.
 * The first call will have no aggregated response. Subsequent calls will
 * concatenate the new responses to the original one.
 */
function pagedGet(
  client,
  method,
  pageLimit,
  query = {},
  skip = 0,
  aggregatedResponse = null
) {
  return client[method]({
    ...query,
    skip: skip,
    limit: pageLimit,
    order: `sys.createdAt`,
  }).then(response => {
    if (!aggregatedResponse) {
      aggregatedResponse = response
    } else {
      aggregatedResponse.items = aggregatedResponse.items.concat(response.items)
    }
    if (skip + pageLimit <= response.total) {
      return pagedGet(
        client,
        method,
        pageLimit,
        query,
        skip + pageLimit,
        aggregatedResponse
      )
    }
    return aggregatedResponse
  })
}
