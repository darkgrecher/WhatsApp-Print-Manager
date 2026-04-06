# WhatsApp Print Manager

A desktop application for bookshops to download and print files received via WhatsApp.

## Features

- QR code login with WhatsApp Linked Devices
- View unread chats and files quickly
- Batch download and print flow
- Works with PDFs, images, Office files, and more
- Persistent WhatsApp session
- Built-in app updates using electron-updater

## Prerequisites

- Node.js 18+
- Windows 10 or Windows 11
- GitHub repository access (for release publishing)

## Install And Run (Development)

```powershell
# from project root
npm install
npm start
```

## Build Commands

```powershell
# local build only (no GitHub publish)
npm run build

# publish release to GitHub (creates release + uploads assets)
npm run release
```

## Release Guide (Step By Step)

This section is the exact process to release a new version.

### Example Scenario

- Installed version on PC: 3.0.5
- New version to release on GitHub: 3.0.9

### Step 1: Check Repository State

```powershell
git branch --show-current
git status --short
```

Make sure you are on the correct branch and there are no unexpected changes.

### Step 2: Ensure GitHub Token Is Available

Store your token in `.env`:

```env
GH_TOKEN="YOUR_GITHUB_TOKEN"
```

Load token in current PowerShell session:

```powershell
$line=(Get-Content .env | Where-Object { $_ -match '^\s*GH_TOKEN\s*=' } | Select-Object -First 1)
$val=($line -split '=',2)[1].Trim().Trim('"').Trim("'")
$env:GH_TOKEN=$val
$env:GITHUB_TOKEN=$val
```

Validate token:

```powershell
$h=@{Authorization="Bearer $env:GH_TOKEN"; "User-Agent"="wpm-release"; Accept="application/vnd.github+json"}
(Invoke-WebRequest https://api.github.com/user -Headers $h).StatusCode
```

Expected output: `200`

### Step 3: Bump Version

```powershell
npm version 3.0.9 --no-git-tag-version
```

This updates both `package.json` and `package-lock.json`.

### Step 4: Commit Version Change

```powershell
git add package.json package-lock.json
git commit -m "release: v3.0.9"
```

### Step 5: Create And Push Tag

```powershell
git tag v3.0.9
git push origin sessionsave
git push origin v3.0.9
```

### Step 6: Publish Release

```powershell
npm run release
```

What this does:

- Builds Windows installer
- Generates `latest.yml`
- Uploads `.exe`, `.blockmap`, and `latest.yml` to GitHub release

### Step 7: Verify Release Assets

```powershell
Invoke-RestMethod https://api.github.com/repos/darkgrecher/WhatsApp-Print-Manager/releases/tags/v3.0.9 |
    Select-Object tag_name,draft,prerelease
```

Check asset URL:

```powershell
Invoke-WebRequest -Method Head https://github.com/darkgrecher/WhatsApp-Print-Manager/releases/download/v3.0.9/latest.yml
```

Expected status: `200`

## Test Update Flow (3.0.5 -> 3.0.9)

1. Install 3.0.5 build on your test PC.
2. Start app.
3. App checks updates on startup (if enabled in current code).
4. Or click Check for Updates.
5. Confirm update window appears and progress bar updates in real time.
6. After download, app installs update and restarts.

## Local Test Build Only (No Publish)

Use this when you want to test installer behavior without creating a GitHub release.

```powershell
npm run build
```

Output is generated in `dist/`.

## Troubleshooting (Release)

- 401 Bad credentials:
    - Token is invalid/revoked or not loaded in current shell.
- latest.yml 404:
    - Release not published or assets not uploaded.
- Update not detected:
    - Verify current app version is lower than released tag.
    - Verify `latest.yml` URL for that tag returns 200.

## Notes

- This project publishes with `releaseType: release` so assets are public in release page.
- For private-repo update access, runtime token handling may be required on client machines.

## License

MIT
