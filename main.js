const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  TFile,
  moment,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  debugEnabled: true,
  debugLogPath: "Journal/_System/FlexibleNotes Log.md",
  debugLevel: "standard",
  openLogOnError: true,
  noteDefinitions: [
    {
      id: "daily-reflection",
      enabled: true,
      name: "Daily Reflection",
      templatePath: "Templates/Daily Reflection.md",
      destinationRoot: "Journal/Daily Reflection",
      folderPattern: "{{year}}/{{month}}",
      filenamePattern: "{{day}}",
      ifExists: "open",
      openAfterCreate: true,
    },
    {
      id: "morning-pages",
      enabled: true,
      name: "Morning Pages",
      templatePath: "Templates/Morning Pages.md",
      destinationRoot: "Journal/Morning Pages",
      folderPattern: "{{year}}/{{month}}",
      filenamePattern: "{{day}}",
      ifExists: "open",
      openAfterCreate: true,
    },
  ],
};

const TOKEN_HELP =
  "Available tokens: {{date}} -> 2026-04-11, {{year}} -> 2026, {{month}} -> April, {{day}} -> 11";

module.exports = class FlexibleNotesPlugin extends Plugin {
  async onload() {
    this.noteCommandIds = [];
    await this.loadSettings();

    this.addSettingTab(new FlexibleNotesSettingTab(this.app, this));

    this.addCommand({
      id: "open-debug-log",
      name: "Open debug log",
      callback: async () => {
        await this.openDebugLog();
      },
    });

    this.addCommand({
      id: "clear-debug-log",
      name: "Clear debug log",
      callback: async () => {
        await this.clearDebugLog();
      },
    });

    this.registerObsidianProtocolHandler("flexible-notes", async (params) => {
      await this.handleProtocolRequest(params || {});
    });

    this.refreshNoteTypeCommands();
  }

  onunload() {
    this.clearNoteTypeCommands();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});

    if (!Array.isArray(this.settings.noteDefinitions)) {
      this.settings.noteDefinitions = DEFAULT_SETTINGS.noteDefinitions.map((def) => ({ ...def }));
    }

    for (const def of this.settings.noteDefinitions) {
      this.normalizeDefinitionForStorage(def);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshNoteTypeCommands();
  }

  normalizeDefinitionForStorage(def) {
    if (!def.id) def.id = this.makeId(def.name || "note-type");
    if (typeof def.enabled !== "boolean") def.enabled = true;
    if (typeof def.name !== "string") def.name = "";
    if (typeof def.templatePath !== "string") def.templatePath = "";
    if (typeof def.destinationRoot !== "string") def.destinationRoot = "";
    if (typeof def.folderPattern !== "string") def.folderPattern = "";
    if (typeof def.filenamePattern !== "string") def.filenamePattern = "";
    if (!["open", "skip", "duplicate"].includes(def.ifExists)) def.ifExists = "open";
    if (typeof def.openAfterCreate !== "boolean") def.openAfterCreate = true;

    def.templatePath = this.ensureMarkdownPath(this.normalizeVaultPath(def.templatePath));
    def.destinationRoot = this.normalizeVaultPath(def.destinationRoot);
    def.folderPattern = this.normalizeVaultPath(def.folderPattern);
    def.filenamePattern = this.normalizeVaultPath(def.filenamePattern);
  }

  clearNoteTypeCommands() {
    for (const id of this.noteCommandIds || []) {
      if (this.app.commands && typeof this.app.commands.removeCommand === "function") {
        this.app.commands.removeCommand(id);
      }
    }
    this.noteCommandIds = [];
  }

  refreshNoteTypeCommands() {
    this.clearNoteTypeCommands();

    for (const def of this.settings.noteDefinitions) {
      if (!def.enabled || !def.name) continue;

      const id = `create-open-${def.id}`;
      this.addCommand({
        id,
        name: `Create or open ${def.name}`,
        callback: async () => {
          await this.createOrOpenNote(def);
        },
      });
      this.noteCommandIds.push(id);
    }
  }

  async handleProtocolRequest(params) {
    const rawParams = this.stringifyUriParams(params);
    const type = this.decodeUriValue(params.type || "").trim();
    const date = this.decodeUriValue(params.date || "").trim();
    const dateValidation = this.validateUriDate(date);

    if (!dateValidation.ok) {
      await this.handleUriError(`Invalid date: ${date}`, {
        rawParams,
        decodedType: type,
        dateUsed: date,
      });
      return;
    }

    if (!type) {
      await this.openNoteTypePicker(dateValidation.date, rawParams);
      return;
    }

    const match = this.findNoteDefinitionMatch(type);
    if (match.disabled) {
      await this.handleUriError(`Note type is disabled: ${type}`, {
        rawParams,
        decodedType: type,
        dateUsed: dateValidation.date,
        matchedNoteTypeId: match.definition.id,
        matchedNoteTypeName: match.definition.name,
      });
      return;
    }

    if (!match.definition) {
      await this.handleUriError(`Note type not found: ${type}`, {
        rawParams,
        decodedType: type,
        dateUsed: dateValidation.date,
      });
      return;
    }

    await this.logUriAction({
      rawParams,
      decodedType: type,
      dateUsed: dateValidation.date,
      matchedNoteTypeId: match.definition.id,
      matchedNoteTypeName: match.definition.name,
      action: "run direct",
    });
    await this.createOrOpenNote(match.definition, {
      date: dateValidation.date,
      uriContext: {
        rawParams,
        decodedType: type,
        dateUsed: dateValidation.date,
        matchedNoteTypeId: match.definition.id,
        matchedNoteTypeName: match.definition.name,
      },
    });
  }

  decodeUriValue(value) {
    const text = String(value || "");
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch (error) {
      return text;
    }
  }

  stringifyUriParams(params) {
    return JSON.stringify(params || {});
  }

  validateUriDate(date) {
    if (!date) return { ok: true, date: "" };
    const parsed = moment(date, "YYYY-MM-DD", true);
    if (!parsed.isValid()) return { ok: false, date };
    return { ok: true, date: parsed.format("YYYY-MM-DD") };
  }

  findNoteDefinitionMatch(type) {
    const wanted = String(type).trim().toLowerCase();
    const definition = this.settings.noteDefinitions.find((def) => {
      return this.noteDefinitionMatches(def, wanted);
    });

    if (!definition) return { definition: null, disabled: false };
    return { definition, disabled: !definition.enabled };
  }

  noteDefinitionMatches(definition, wanted) {
    return (
      String(definition.name || "").trim().toLowerCase() === wanted ||
      String(definition.id || "").trim().toLowerCase() === wanted
    );
  }

  getEnabledNoteDefinitions() {
    return this.settings.noteDefinitions.filter((def) => def.enabled && def.name);
  }

  async openNoteTypePicker(date, rawParams) {
    const enabledDefinitions = this.getEnabledNoteDefinitions();

    if (enabledDefinitions.length === 0) {
      await this.handleUriError("No enabled note types.", {
        rawParams,
        dateUsed: date,
      });
      return;
    }

    if (enabledDefinitions.length === 1) {
      const definition = enabledDefinitions[0];
      await this.logUriAction({
        rawParams,
        dateUsed: date,
        matchedNoteTypeId: definition.id,
        matchedNoteTypeName: definition.name,
        action: "run single enabled note type",
      });
      await this.createOrOpenNote(definition, {
        date,
        uriContext: {
          rawParams,
          dateUsed: date,
          matchedNoteTypeId: definition.id,
          matchedNoteTypeName: definition.name,
        },
      });
      return;
    }

    await this.logUriAction({
      rawParams,
      dateUsed: date,
      action: "open picker",
    });

    new FlexibleNotesPickerModal(this.app, this, enabledDefinitions, date, rawParams).open();
  }

  async runPickedNoteType(definition, date, rawParams) {
    await this.logUriAction({
      rawParams,
      dateUsed: date,
      matchedNoteTypeId: definition.id,
      matchedNoteTypeName: definition.name,
      action: "run picker selection",
    });
    await this.createOrOpenNote(definition, {
      date,
      uriContext: {
        rawParams,
        dateUsed: date,
        matchedNoteTypeId: definition.id,
        matchedNoteTypeName: definition.name,
      },
    });
  }

  async handleUriError(message, details) {
    await this.logUriAction({
      ...details,
      action: "error",
      errorMessage: message,
    });
    new Notice(message);
    if (this.settings.openLogOnError) {
      await this.openDebugLog();
    }
  }

  async logUriAction(details) {
    await this.log("standard", "URI", details.action || "uri", {
      rawUriParameters: details.rawParams || "",
      decodedType: details.decodedType || "",
      dateUsed: details.dateUsed || moment().format("YYYY-MM-DD"),
      matchedNoteTypeId: details.matchedNoteTypeId || "",
      matchedNoteTypeName: details.matchedNoteTypeName || "",
      errorMessage: details.errorMessage || "",
    });
  }

  makeId(input) {
    return (
      String(input || "note-type")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `note-type-${Date.now()}`
    );
  }

  normalizeVaultPath(input) {
    return normalizePath(String(input || "").trim().replace(/\\/g, "/")).replace(/^\/+/, "");
  }

  ensureMarkdownPath(input) {
    if (!input) return "";
    return input.toLowerCase().endsWith(".md") ? input : `${input}.md`;
  }

  validateVaultPath(path, label, options = {}) {
    const normalized = options.markdown ? this.ensureMarkdownPath(this.normalizeVaultPath(path)) : this.normalizeVaultPath(path);
    if (!normalized) return { ok: false, path: normalized, message: `${label} is required.` };
    if (normalized.includes("//")) return { ok: false, path: normalized, message: `${label} contains an empty folder segment.` };
    if (normalized.split("/").some((part) => part === "." || part === "..")) {
      return { ok: false, path: normalized, message: `${label} cannot contain . or ... segments.` };
    }
    if (/[:*?"<>|]/.test(normalized)) {
      return { ok: false, path: normalized, message: `${label} contains invalid characters.` };
    }
    return { ok: true, path: normalized };
  }

  async validateTemplatePath(path) {
    const result = this.validateVaultPath(path, "Template path", { markdown: true });
    if (!result.ok) return result;

    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!(file instanceof TFile)) {
      return { ok: false, path: result.path, message: `Template not found: ${result.path}` };
    }

    return result;
  }

  validateDestinationRoot(path) {
    return this.validateVaultPath(path, "Destination root");
  }

  getDateContext(noteTypeName, dateInput) {
    const now = dateInput ? moment(dateInput, "YYYY-MM-DD", true) : moment();
    if (!now.isValid()) {
      throw new Error(`Invalid date: ${dateInput}. Use YYYY-MM-DD.`);
    }

    return {
      date: now.format("YYYY-MM-DD"),
      year: now.format("YYYY"),
      month: now.format("MMMM"),
      monthNumber: now.format("MM"),
      day: now.format("DD"),
      dayNumber: now.format("DD"),
      noteType: noteTypeName,
    };
  }

  applyTokens(input, context) {
    let output = String(input || "");
    const pairs = {
      "{{date}}": context.date,
      "{{year}}": context.year,
      "{{month}}": context.month,
      "{{monthNumber}}": context.monthNumber,
      "{{day}}": context.day,
      "{{dayNumber}}": context.dayNumber,
      "{{noteType}}": context.noteType,
    };

    for (const [token, value] of Object.entries(pairs)) {
      output = output.split(token).join(value);
    }

    return output;
  }

  buildNotePath(definition, context) {
    const destinationRoot = this.validateDestinationRoot(definition.destinationRoot);
    if (!destinationRoot.ok) throw new Error(destinationRoot.message);
    if (!definition.folderPattern) throw new Error(`Folder pattern is required for ${definition.name}.`);
    if (!definition.filenamePattern) throw new Error(`Filename pattern is required for ${definition.name}.`);

    const folderPattern = this.normalizeVaultPath(this.applyTokens(definition.folderPattern, context));
    let filename = this.normalizeVaultPath(this.applyTokens(definition.filenamePattern, context));
    filename = this.ensureMarkdownPath(filename);

    const folderValidation = this.validateVaultPath(folderPattern || destinationRoot.path, "Folder path");
    if (!folderValidation.ok) throw new Error(folderValidation.message);

    const filenameValidation = this.validateVaultPath(filename, "Filename", { markdown: true });
    if (!filenameValidation.ok) throw new Error(filenameValidation.message);

    const folderPath = this.normalizeVaultPath([destinationRoot.path, folderPattern].filter(Boolean).join("/"));
    const fullPath = this.normalizeVaultPath([folderPath, filenameValidation.path].filter(Boolean).join("/"));

    return { folderPath, fullPath, filename: filenameValidation.path };
  }

  buildPreviewPath(definition) {
    const context = this.getDateContext(definition.name || "Daily Reflection", "2026-04-11");
    const { fullPath } = this.buildNotePath(definition, context);
    return fullPath;
  }

  async ensureFolder(folderPath) {
    const normalized = this.normalizeVaultPath(folderPath);
    if (!normalized) return;

    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async getTemplateContent(templatePath, context) {
    const resolvedTemplatePath = this.ensureMarkdownPath(this.normalizeVaultPath(this.applyTokens(templatePath, context)));
    const templateFile = this.app.vault.getAbstractFileByPath(resolvedTemplatePath);

    if (!(templateFile instanceof TFile)) {
      throw new Error(`Template not found: ${resolvedTemplatePath}`);
    }

    const raw = await this.app.vault.read(templateFile);
    return {
      resolvedTemplatePath,
      content: this.applyTokens(raw, context),
    };
  }

  async createOrOpenNote(definition, options = {}) {
    let context;
    let pathInfo = {};
    let resolvedTemplatePath = "";

    try {
      context = this.getDateContext(definition.name, options.date);
      pathInfo = this.buildNotePath(definition, context);
      resolvedTemplatePath = this.ensureMarkdownPath(this.normalizeVaultPath(this.applyTokens(definition.templatePath, context)));

      await this.log("verbose", definition.name, "resolved", {
        resolvedTemplatePath,
        resolvedDestinationPath: pathInfo.fullPath,
      });

      await this.ensureFolder(pathInfo.folderPath);

      const existing = this.app.vault.getAbstractFileByPath(pathInfo.fullPath);
      if (existing instanceof TFile) {
        await this.handleExisting(existing, definition, pathInfo.fullPath, resolvedTemplatePath, context);
        return;
      }

      const template = await this.getTemplateContent(definition.templatePath, context);
      resolvedTemplatePath = template.resolvedTemplatePath;
      const file = await this.app.vault.create(pathInfo.fullPath, template.content);

      await this.log("standard", definition.name, "created", {
        resolvedTemplatePath,
        resolvedDestinationPath: pathInfo.fullPath,
      });

      new Notice(`Created ${definition.name}`);
      if (definition.openAfterCreate) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.uriContext) {
        await this.logUriAction({
          ...options.uriContext,
          action: "error",
          errorMessage: message,
        });
      }
      await this.handleError(definition.name, message, {
        action: "error",
        resolvedTemplatePath,
        resolvedDestinationPath: pathInfo.fullPath || "",
        errorMessage: message,
      });
    }
  }

  async handleExisting(existingFile, definition, fullPath, resolvedTemplatePath, context) {
    const mode = definition.ifExists;

    if (mode === "skip") {
      await this.log("standard", definition.name, "skipped", {
        resolvedTemplatePath,
        resolvedDestinationPath: fullPath,
      });
      new Notice(`${definition.name} already exists`);
      return;
    }

    if (mode === "duplicate") {
      const duplicatePath = await this.findDuplicatePath(fullPath);
      const template = await this.getTemplateContent(definition.templatePath, context);
      const duplicate = await this.app.vault.create(duplicatePath, template.content);
      await this.log("standard", definition.name, "created duplicate", {
        resolvedTemplatePath: template.resolvedTemplatePath,
        resolvedDestinationPath: duplicatePath,
      });
      new Notice(`Created duplicate ${definition.name}`);
      if (definition.openAfterCreate) {
        await this.app.workspace.getLeaf(true).openFile(duplicate);
      }
      return;
    }

    await this.log("standard", definition.name, "opened", {
      resolvedTemplatePath,
      resolvedDestinationPath: fullPath,
    });
    new Notice(`Opened existing ${definition.name}`);
    await this.app.workspace.getLeaf(true).openFile(existingFile);
  }

  async findDuplicatePath(fullPath) {
    const base = fullPath.replace(/\.md$/i, "");
    let count = 2;
    let candidate = `${base} (${count}).md`;

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      count += 1;
      candidate = `${base} (${count}).md`;
    }

    return this.normalizeVaultPath(candidate);
  }

  async handleError(noteType, message, details = {}) {
    await this.log("errors", noteType, "error", details);
    new Notice(`Flexible Notes error: ${message}`);
    if (this.settings.openLogOnError) {
      await this.openDebugLog();
    }
  }

  async log(level, noteType, action, details = {}) {
    if (!this.settings.debugEnabled) return;

    const order = { errors: 1, standard: 2, verbose: 3 };
    const configured = order[this.settings.debugLevel] || 2;
    const current = order[level] || 2;
    if (current > configured) return;

    const logPath = this.ensureMarkdownPath(this.normalizeVaultPath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath));
    const parent = logPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await this.ensureFolder(parent);
    }

    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
    const lines = [
      `## ${timestamp}`,
      `- Timestamp: ${timestamp}`,
      `- Note type: ${noteType}`,
      `- Action: ${action}`,
      `- Resolved template path: ${details.resolvedTemplatePath || ""}`,
      `- Resolved destination path: ${details.resolvedDestinationPath || ""}`,
    ];

    if (details.errorMessage) {
      lines.push(`- Error message: ${details.errorMessage}`);
    }

    if (details.rawUriParameters) {
      lines.push(`- Raw URI parameters: ${details.rawUriParameters}`);
      lines.push(`- Decoded type: ${details.decodedType || ""}`);
      lines.push(`- Date used: ${details.dateUsed || ""}`);
      lines.push(`- Matched note type ID: ${details.matchedNoteTypeId || ""}`);
      lines.push(`- Matched note type name: ${details.matchedNoteTypeName || ""}`);
    }

    lines.push("");

    const exists = await this.app.vault.adapter.exists(logPath);
    if (!exists) {
      await this.app.vault.adapter.write(logPath, "# Flexible Notes Debug Log\n\n");
    }

    await this.app.vault.adapter.append(logPath, lines.join("\n"));
  }

  async openDebugLog() {
    const logPath = this.ensureMarkdownPath(this.normalizeVaultPath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath));
    const parent = logPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await this.ensureFolder(parent);
    }

    let file = this.app.vault.getAbstractFileByPath(logPath);
    if (!(file instanceof TFile)) {
      file = await this.app.vault.create(logPath, "# Flexible Notes Debug Log\n\n");
    }

    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async clearDebugLog() {
    const logPath = this.ensureMarkdownPath(this.normalizeVaultPath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath));
    const parent = logPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await this.ensureFolder(parent);
    }

    await this.app.vault.adapter.write(logPath, "# Flexible Notes Debug Log\n\n");
    new Notice("Flexible Notes debug log cleared");
    await this.openDebugLog();
  }
};

class FlexibleNotesPickerModal extends Modal {
  constructor(app, plugin, noteDefinitions, date, rawParams) {
    super(app);
    this.plugin = plugin;
    this.noteDefinitions = noteDefinitions;
    this.date = date;
    this.rawParams = rawParams;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("flexible-notes-picker");

    contentEl.createEl("h2", { text: "Flexible Notes" });

    const list = contentEl.createDiv({ cls: "flexible-notes-picker-list" });
    for (const definition of this.noteDefinitions) {
      const button = list.createEl("button", {
        cls: "flexible-notes-picker-item",
        text: definition.name,
      });
      button.addEventListener("click", async () => {
        this.close();
        await this.plugin.runPickedNoteType(definition, this.date, this.rawParams);
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FlexibleNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Flexible Notes" });

    containerEl.createEl("h3", { text: "Debug logging" });

    new Setting(containerEl)
      .setName("Enable debug logging")
      .setDesc("Write actions and errors to a markdown log file in your vault.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugEnabled).onChange(async (value) => {
          this.plugin.settings.debugEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debug log path")
      .setDesc("Vault-relative markdown path for the debug log.")
      .addText((text) =>
        text
          .setPlaceholder("Journal/_System/FlexibleNotes Log.md")
          .setValue(this.plugin.settings.debugLogPath)
          .onChange(async (value) => {
            const path = this.plugin.ensureMarkdownPath(this.plugin.normalizeVaultPath(value || DEFAULT_SETTINGS.debugLogPath));
            this.plugin.settings.debugLogPath = path;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug level")
      .setDesc("How much detail to write to the debug log.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("errors", "Errors only")
          .addOption("standard", "Standard")
          .addOption("verbose", "Verbose")
          .setValue(this.plugin.settings.debugLevel)
          .onChange(async (value) => {
            this.plugin.settings.debugLevel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open debug log on error")
      .setDesc("Automatically open the log when note creation fails.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openLogOnError).onChange(async (value) => {
          this.plugin.settings.openLogOnError = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Note types" });

    this.plugin.settings.noteDefinitions.forEach((def, index) => {
      this.renderNoteType(containerEl, def, index);
    });

    new Setting(containerEl)
      .setName("Add note type")
      .setDesc("Creates a new flexible note definition.")
      .addButton((button) =>
        button
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.noteDefinitions.push({
              id: `note-type-${Date.now()}`,
              enabled: true,
              name: "New Note Type",
              templatePath: "Templates/New Note Type.md",
              destinationRoot: "Journal/New Note Type",
              folderPattern: "{{year}}/{{month}}",
              filenamePattern: "{{day}}",
              ifExists: "open",
              openAfterCreate: true,
            });
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  renderNoteType(containerEl, def, index) {
    const section = containerEl.createDiv({ cls: "flexible-notes-section" });
    section.createEl("h4", { text: def.name || `Note type ${index + 1}` });

    const errorEl = section.createDiv({ cls: "flexible-notes-error" });
    errorEl.classList.add("is-hidden");
    const previewEl = section.createDiv({ cls: "flexible-notes-preview" });

    const draft = { ...def };
    const showError = (message) => {
      errorEl.setText(message || "");
      errorEl.classList.toggle("is-hidden", !message);
    };
    const updatePreview = () => {
      try {
        previewEl.setText(`Example output: ${this.plugin.buildPreviewPath(draft)}`);
      } catch (error) {
        previewEl.setText("Example output: cannot resolve current settings");
      }
    };
    const saveDraft = async () => {
      Object.assign(def, draft);
      this.plugin.normalizeDefinitionForStorage(def);
      await this.plugin.saveSettings();
      updatePreview();
    };

    updatePreview();

    new Setting(section)
      .setName("Enabled")
      .addToggle((toggle) =>
        toggle.setValue(def.enabled).onChange(async (value) => {
          draft.enabled = value;
          await saveDraft();
        })
      );

    new Setting(section)
      .setName("Name")
      .addText((text) =>
        text.setValue(def.name || "").onChange(async (value) => {
          draft.name = value.trim();
          draft.id = this.plugin.makeId(draft.name || def.id || `note-type-${index + 1}`);
          await saveDraft();
          showError("");
        })
      );

    new Setting(section)
      .setName("Template path")
      .setDesc("Vault-relative markdown file. Any .md file can be used.")
      .addText((text) =>
        text.setValue(def.templatePath || "").onChange(async (value) => {
          draft.templatePath = this.plugin.ensureMarkdownPath(this.plugin.normalizeVaultPath(value));
          const result = await this.plugin.validateTemplatePath(draft.templatePath);
          updatePreview();
          if (!result.ok) {
            showError(result.message);
            return;
          }
          draft.templatePath = result.path;
          await saveDraft();
          showError("");
        })
      );

    new Setting(section)
      .setName("Destination root")
      .setDesc("Vault-relative folder path. Missing folders are created automatically.")
      .addText((text) =>
        text.setValue(def.destinationRoot || "").onChange(async (value) => {
          draft.destinationRoot = this.plugin.normalizeVaultPath(value);
          const result = this.plugin.validateDestinationRoot(draft.destinationRoot);
          updatePreview();
          if (!result.ok) {
            showError(result.message);
            return;
          }
          draft.destinationRoot = result.path;
          await saveDraft();
          showError("");
        })
      );

    new Setting(section)
      .setName("Folder pattern")
      .setDesc(TOKEN_HELP)
      .addText((text) =>
        text.setValue(def.folderPattern || "").onChange(async (value) => {
          draft.folderPattern = this.plugin.normalizeVaultPath(value);
          updatePreview();
          if (!draft.folderPattern) {
            showError("Folder pattern is required.");
            return;
          }
          await saveDraft();
          showError("");
        })
      );

    new Setting(section)
      .setName("Filename pattern")
      .setDesc(TOKEN_HELP)
      .addText((text) =>
        text.setValue(def.filenamePattern || "").onChange(async (value) => {
          draft.filenamePattern = this.plugin.normalizeVaultPath(value);
          updatePreview();
          if (!draft.filenamePattern) {
            showError("Filename pattern is required.");
            return;
          }
          await saveDraft();
          showError("");
        })
      );

    new Setting(section)
      .setName("If file exists")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("open", "Open existing")
          .addOption("skip", "Skip")
          .addOption("duplicate", "Create duplicate")
          .setValue(def.ifExists)
          .onChange(async (value) => {
            draft.ifExists = value;
            await saveDraft();
          })
      );

    new Setting(section)
      .setName("Open after create")
      .addToggle((toggle) =>
        toggle.setValue(def.openAfterCreate).onChange(async (value) => {
          draft.openAfterCreate = value;
          await saveDraft();
        })
      );

    const deleteSetting = new Setting(section)
      .setName("Delete this note type")
      .setDesc("Removes it from settings.")
      .addButton((button) =>
        button
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => {
            deleteSetting.settingEl.empty();
            deleteSetting.settingEl.createDiv({ text: "Are you sure you want to delete this note type?" });
            const controls = deleteSetting.settingEl.createDiv({ cls: "flexible-notes-confirm" });
            controls.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.display());
            controls.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", async () => {
              this.plugin.settings.noteDefinitions.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            });
          })
      );
  }
}
