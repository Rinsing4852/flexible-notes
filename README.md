# Flexible Notes v0.2.0

An Obsidian plugin for creating or opening user-defined note types from settings, commands, or iOS Shortcuts.

## What it does

- Lets you define custom note types such as **Morning Pages** or **Daily Reflection**.
- Each note type has its own:
  - template file
  - destination root folder
  - folder pattern
  - filename pattern
  - existing-file behaviour
- Creates missing folders automatically.
- Opens today's note if it already exists.
- Writes an optional markdown debug log in the vault.
- Supports Obsidian URI automation for iOS Shortcuts and Siri.
- Works without Templater.
- Designed to stay mobile-friendly.

## Default pattern tokens

Supported in folder pattern, filename pattern, and template content:

- `{{date}}` -> `YYYY-MM-DD`
- `{{year}}` -> `2026`
- `{{month}}` -> `April`
- `{{monthNumber}}` -> `04`
- `{{day}}` -> `11`
- `{{dayNumber}}` -> `11`
- `{{noteType}}` -> note type name

## Example configuration

### Morning Pages
- Template path: `Templates/Morning Pages.md`
- Destination root: `Journal/Morning Pages`
- Folder pattern: `{{year}}/{{month}}`
- Filename pattern: `{{day}}`

This creates:

`Journal/Morning Pages/2026/April/11.md`

## Commands

- Create or open each enabled note type (registered dynamically)
- Flexible Notes: open debug log
- Flexible Notes: clear debug log

## Shortcuts

Run a note type from an Obsidian URI:

`obsidian://flexible-notes?type=Daily%20Reflection`

An optional date can be supplied in `YYYY-MM-DD` format:

`obsidian://flexible-notes?type=Daily%20Reflection&date=2026-04-11`

## Install for testing

1. Create a folder in your vault:
   `.obsidian/plugins/flexible-notes/`
2. Copy these files into it:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. In Obsidian:
   - Settings -> Community plugins
   - Turn off Safe mode if needed
   - Reload community plugins
   - Enable **Flexible Notes**

## Notes

This is intentionally focused:
- no calendar logic
- no Templater integration
- no scheduling engine
- no fancy template browser
