# Redside HD Bill Puller

## Install and check

1. Download and extract this repository.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and select **Load unpacked**. Choose the folder containing `manifest.json`.
3. Sign in to the Citi commercial portal for your Home Depot account. With that tab open, open the extension popup and select **Dry run** to check which invoices it would select. Review the popup log.
4. Select **Run** when you are ready to request the PDFs. The extension saves them under your browser’s Downloads folder in `redside-hd`.

## Gmail setup

PDF downloads work without Gmail setup. To enable sending from your Gmail account:

1. Enable the Gmail API in a Google Cloud project and configure its OAuth consent screen. If the app is in testing, add the Gmail account you plan to use as a test user.
2. Create an OAuth client of type **Chrome Extension**. Use the extension ID shown on `chrome://extensions` for your loaded copy.
3. In your local `manifest.json`, replace the placeholder `oauth2.client_id` with the OAuth client ID. Keep the `https://www.googleapis.com/auth/gmail.send` scope and reload the extension from `chrome://extensions`.
4. Enter a recipient in **Send batch to**. After a batch downloads, select **Send this batch** and approve Gmail access when Chrome prompts you.
