const { App, LogLevel, AwsLambdaReceiver } = require('@slack/bolt')
const chromium = require("@sparticuz/chromium")
const puppeteer = require("puppeteer-core")

chromium.setHeadlessMode = true
chromium.setGraphicsMode = false

const awsLambdaReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
})

const protocol = process.env.ENV === 'development' ? 'http' : 'https'

const redashHost = process.env.REDASH_HOST

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: awsLambdaReceiver,
  processBeforeResponse: false,
  logLevel: LogLevel.INFO,
})

// Send the API key in the Authorization header, not in the URL, so it doesn't end up in access logs.
const getRedashApi = async (path) => {
  const res = await fetch(`${protocol}://${redashHost}${path}`, {
    headers: { Authorization: `Key ${process.env.REDASH_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`Redash API error: ${res.status} ${path}`)
  }
  return res.json()
}

const getQuery = (queryId) => getRedashApi(`/api/queries/${queryId}`)

const getDashboard = (dashboardId) => getRedashApi(`/api/dashboards/${dashboardId}`)

const uploadScreenShot = async ({ client, body, record }) => {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: true
  })

  const text = body['event']['text']
  const queryRegex = new RegExp(`${protocol}://${redashHost}/queries/([0-9]+)(?:#([0-9]+))?`)
  const dashboardRegex = new RegExp(`${protocol}://${redashHost}/dashboards/([0-9]+)-[0-9a-z_-]+`)

  let embedUrl
  let fileName
  let filePath
  let originalUrl

  const page = await browser.newPage()
  page.setViewport({ width: 1024, height: 480 })

  if (text.match(queryRegex)) {
    const matches = text.match(queryRegex)
    const queryId = matches[1]
    record.target_type = 'query'
    record.target_id = queryId
    const query = await getQuery(queryId)
    const visualizationId = matches[2] || query.visualizations[0].id
    record.visualization_id = String(visualizationId)
    embedUrl = `${protocol}://${redashHost}/embed/query/${queryId}/visualization/${visualizationId}`
    // Pass the API key as a header, and only on requests to Redash (not to any other host the page may load)
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (new URL(request.url()).host === redashHost) {
        request.continue({
          headers: { ...request.headers(), Authorization: `Key ${process.env.REDASH_API_KEY}` },
        })
      } else {
        request.continue()
      }
    })
    fileName = query.name
    // Build the path from IDs, not from the name (names can contain "/" or "../")
    filePath = `/tmp/query-${queryId}-${visualizationId}.png`
    originalUrl = matches[0]
  } else if (text.match(dashboardRegex)) {
    const matches = text.match(dashboardRegex)
    const dashboardId = matches[1]
    record.target_type = 'dashboard'
    record.target_id = dashboardId
    const dashboard = await getDashboard(dashboardId)
    embedUrl = dashboard.public_url
    fileName = dashboard.name
    filePath = `/tmp/dashboard-${dashboardId}.png`
    originalUrl = matches[0]
  } else {
    throw('Invalid URL')
  }

  await page.goto(embedUrl)
  await page.waitForResponse(response => response.request().url().includes('/results'));
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ fullPage: true, path: filePath })

  await browser.close()

  await client.filesUploadV2({
    channel_id: body['event']['channel'],
    initial_comment: `Taking screenshot of ${originalUrl}`,
    file: filePath,
    filename: fileName,
    filetype: 'png'
  })
}

app.event('app_mention', async ({ client, body, say }) => {
  if (body['event']['text'].includes('ping')) {
    await say(`pong :table_tennis_paddle_and_ball: (Node.js ${process.version})`)
  } else {
    // One line per screenshot: who took what, and whether it worked. Uses console.log so it is
    // written regardless of Bolt's logLevel. Never put the API key, URLs or the message text here.
    const record = {
      event: 'redash_screenshot',
      user: body['event']['user'],
      channel: body['event']['channel'],
      target_type: null,
      target_id: null,
      visualization_id: null,
    }
    try {
      await uploadScreenShot({ client, body, record })
      console.log(JSON.stringify({ ...record, result: 'success' }))
    } catch (e) {
      console.log(JSON.stringify({ ...record, result: 'failure', error: e instanceof Error ? e.message : String(e) }))
      throw e
    }
  }
})

const fs = require('fs');

module.exports.handler = async (event, context, callback) => {
  const handler = await app.start()

  // slack will retry if response is not returned within 3 seconds.
  // https://api.slack.com/apis/connections/events-api#the-events-api__field-guide__error-handling__graceful-retries
  if (!event.headers['X-Slack-Retry-Num']) {
    return handler(event, context, callback)
  } else {
    return { statusCode: 200, body: JSON.stringify({ message: 'No need to resend' }) }
  }
}
