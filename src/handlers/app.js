const { App, LogLevel, AwsLambdaReceiver } = require('@slack/bolt')
const chromium = require("@sparticuz/chromium")
const axios = require('axios')
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
  logLevel: LogLevel.DEBUG,
})

const getQuery = async (queryId) => {
  const res = await axios.get(`${protocol}://${redashHost}/api/queries/${queryId}?api_key=${process.env.REDASH_API_KEY}`)
  return res.data
}

const getDashboard = async (dashboardId) => {
  const res = await axios.get(`${protocol}://${redashHost}/api/dashboards/${dashboardId}?api_key=${process.env.REDASH_API_KEY}`)
  return res.data
}

const uploadScreenShot = async ({ client, body }) => {
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

  if (text.match(queryRegex)) {
    const matches = text.match(queryRegex)
    const queryId = matches[1]
    const query = await getQuery(queryId)
    const visualizationId = matches[2] || query.visualizations[0].id
    embedUrl = `${protocol}://${redashHost}/embed/query/${queryId}/visualization/${visualizationId}?api_key=${process.env.REDASH_API_KEY}`
    fileName = query.name
    filePath = `/tmp/${fileName}.png`
    originalUrl = matches[0]
  } else if (text.match(dashboardRegex)) {
    const matches = text.match(dashboardRegex)
    const dashboardId = matches[1]
    const dashboard = await getDashboard(dashboardId)
    embedUrl = dashboard.public_url
    fileName = dashboard.name
    filePath = `/tmp/${fileName}.png`
    originalUrl = matches[0]
  } else {
    throw('Invalid URL')
  }

  const page = await browser.newPage()
  page.setViewport({ width: 1024, height: 480 })
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
    await say('pong :table_tennis_paddle_and_ball:')
  } else {
    await uploadScreenShot({ client, body })
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
