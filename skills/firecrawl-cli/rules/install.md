---
name: firecrawl-cli-installation
description: |
  Install the Firecrawl CLI and handle authentication errors.
---

# Firecrawl CLI Installation

## Quick Install

```bash
npm install -g firecrawl-cli@beta
```

## Verify Installation

Check if installed and authenticated in one command:

```bash
firecrawl --version --auth-status
```

Output will show:

- Version number
- `authenticated: true` or `authenticated: false`

## Authentication

If not authenticated, run:

```bash
firecrawl login
```

This will prompt to authenticate either via browser or manually with an API key.

## Authentication Error Handling

If ANY command returns an authentication error (e.g., "not authenticated", "unauthorized", "API key"), use an ask user question tool if available (such as the AskUserQuestion tool in Claude Code):

**Question:** "How would you like to authenticate with Firecrawl?"

**Options:**

1. **Login with browser (Recommended)** - Opens your browser to authenticate with Firecrawl
2. **Enter API key manually** - Paste an existing API key from firecrawl.dev

### If user selects browser login:

Tell them to run `firecrawl login` in their terminal and select option 1. Wait for them to confirm, then retry the original command.

### If user selects manual API key:

Ask for their API key, then run:

```bash
export FIRECRAWL_API_KEY="<their-key>"
```

Tell them to add this export to `~/.zshrc` or `~/.bashrc` for persistence, then retry the original command.

## Troubleshooting

### Command not found

If `firecrawl` command is not found after installation:

1. Make sure npm global bin is in PATH
2. Try: `npx firecrawl-cli@beta --version`
3. Or reinstall: `npm install -g firecrawl-cli@beta`

### Permission errors

If you get permission errors during installation:

```bash
# Option 1: Use sudo (not recommended)
sudo npm install -g firecrawl-cli@beta

# Option 2: Fix npm permissions (recommended)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
# Add the export to your shell profile
```

## Installation error handling

If ANY command returns an authentication error (e.g., "not authenticated", "unauthorized", "API key"), immediately use the AskUserQuestion tool if available- do NOT run firecrawl credit-usage:

question: "How would you like to authenticate with Firecrawl?"
header: "Auth method"
options:
Label: "Login with browser (Recommended)", Description: "Opens your browser to authenticate with Firecrawl"
Label: "Enter API key manually", Description: "Paste an existing API key from firecrawl.dev"
If user selects browser login: Tell them to run firecrawl config in their terminal and select option 1. Wait for them to confirm, then retry the original command.

If user selects manual API key: Ask for their API key, then run:

export FIRECRAWL_API_KEY="<their-key>"
Tell them to add this export to ~/.zshrc or ~/.bashrc for persistence, then retry the original command.

If a user answers that they want to use a browser to authenticate you must run: "echo "1" | firecrawl config"
