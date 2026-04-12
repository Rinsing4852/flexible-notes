const {
  App,
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

module.exports = class FlexibleNotesPlugin extends Plugin {
  async onload() {
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

    this.registerNoteTypeCommands();
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (!Array.isArray(this.settings.noteDefinitions)) {
      this.settings.noteDefinitions = [];
    }

    for (const def of this.settings.noteDefinitions) {
      if (!def.id) def.id = this.makeId(def.name || "note-type");
      if (typeof def.enabled !== "boolean") def.enabled = true;
      if (!def.folderPattern) def.folderPattern = "{{year}}/{{month}}";
      if (!def.filenamePattern) def.filenamePattern = "{{day}}";
      if (!def.ifExists) def.ifExists = "open";
      if (typeof def.openAfterCreate !== "boolean") def.openAfterCreate = true;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  registerNoteTypeCommands() {
    for (const def of this.settings.noteDefinitions) {
      if (!def.enabled || !def.name) continue;

      this.addCommand({
        id: `create-open-${def.id}`,
        name: `Create or open ${def.name}`,
        callback: async () => {
          await this.createOrOpenNote(def);
        },
      });
    }
  }

  makeId(input) {
    return String(input || "note-type")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `note-type-${Date.now()}`;
  }

  getTodayContext(noteTypeName) {
    const now = moment();
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
    const destinationRoot = this.applyTokens(definition.destinationRoot, context).trim();
    const folderPattern = this.applyTokens(definition.folderPattern, context).trim();
    let filename = this.applyTokens(definition.filenamePattern, context).trim();

    if (!filename) filename = context.day;
    if (!filename.endsWith(".md")) filename += ".md";

    const folderPath = [destinationRoot, folderPattern].filter(Boolean).join("/");
    const fullPath = normalizePath([folderPath, filename].filter(Boolean).join("/"));

    return {
      folderPath: normalizePath(folderPath),
      fullPath,
      filename,
    };
  }

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(normalizePath(current));
      if (!exists) {
        await this.app.vault.createFolder(normalizePath(current));
      }
    }
  }

  async getTemplateContent(templatePath, context) {
    const resolvedTemplatePath = normalizePath(this.applyTokens(templatePath, context));
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

  async createOrOpenNote(definition) {
    const context = this.getTodayContext(definition.name);
    const { folderPath, fullPath } = this.buildNotePath(definition, context);

    try {
      await this.log("verbose", definition.name, "Resolved note path", {
        folderPath,
        fullPath,
        templatePath: definition.templatePath,
      });

      await this.ensureFolder(folderPath);

      const existing = this.app.vault.getAbstractFileByPath(fullPath);
      if (existing instanceof TFile) {
        await this.handleExisting(existing, definition, fullPath);
        return;
      }

      const template = await this.getTemplateContent(definition.templatePath, context);
      const file = await this.app.vault.create(fullPath, template.content);

      await this.log("standard", definition.name, "Created file", {
        path: fullPath,
        template: template.resolvedTemplatePath,
      });

      new Notice(`Created ${definition.name}`);
      if (definition.openAfterCreate) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.log("errors", definition.name, "ERROR", {
        message,
        path: fullPath,
        templatePath: definition.templatePath,
      });
      new Notice(`Flexible Notes error: ${message}`);
      if (this.settings.openLogOnError) {
        await this.openDebugLog();
      }
    }
  }

  async handleExisting(existingFile, definition, fullPath) {
    const mode = definition.ifExists || "open";

    if (mode === "skip") {
      await this.log("standard", definition.name, "Skipped existing file", { path: fullPath });
      new Notice(`${definition.name} already exists`);
      return;
    }

    if (mode === "duplicate") {
      const duplicatePath = await this.findDuplicatePath(fullPath);
      const context = this.getTodayContext(definition.name);
      const template = await this.getTemplateContent(definition.templatePath, context);
      const duplicate = await this.app.vault.create(duplicatePath, template.content);
      await this.log("standard", definition.name, "Created duplicate file", {
        path: duplicatePath,
        sourcePath: fullPath,
      });
      new Notice(`Created duplicate ${definition.name}`);
      if (definition.openAfterCreate) {
        await this.app.workspace.getLeaf(true).openFile(duplicate);
      }
      return;
    }

    await this.log("standard", definition.name, "Opened existing file", { path: fullPath });
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

    return normalizePath(candidate);
  }

  async log(level, noteType, action, details = {}) {
    if (!this.settings.debugEnabled) return;

    const order = { errors: 1, standard: 2, verbose: 3 };
    const configured = order[this.settings.debugLevel] || 2;
    const current = order[level] || 2;
    if (current > configured) return;

    const logPath = normalizePath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath);
    const parent = logPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await this.ensureFolder(parent);
    }

    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
    const lines = [
      `## ${timestamp} — ${noteType}`,
      `- Action: ${action}`,
      ...Object.entries(details).map(([k, v]) => `- ${this.toTitleCase(k)}: ${String(v)}`),
      "",
    ];

    const exists = await this.app.vault.adapter.exists(logPath);
    if (!exists) {
      await this.app.vault.adapter.write(logPath, lines.join("\n"));
      return;
    }

    await this.app.vault.adapter.append(logPath, lines.join("\n"));
  }

  toTitleCase(value) {
    return String(value)
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
  }

  async openDebugLog() {
    const logPath = normalizePath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath);
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
    const logPath = normalizePath(this.settings.debugLogPath || DEFAULT_SETTINGS.debugLogPath);
    const parent = logPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await this.ensureFolder(parent);
    }

    const exists = await this.app.vault.adapter.exists(logPath);
    if (!exists) {
      await this.app.vault.adapter.write(logPath, "# Flexible Notes Debug Log\n\n");
    } else {
      await this.app.vault.adapter.write(logPath, "# Flexible Notes Debug Log\n\n");
    }

    new Notice("Flexible Notes debug log cleared");
    await this.openDebugLog();
  }
};

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
        text.setPlaceholder("Journal/_System/FlexibleNotes Log.md")
          .setValue(this.plugin.settings.debugLogPath)
          .onChange(async (value) => {
            this.plugin.settings.debugLogPath = value.trim() || DEFAULT_SETTINGS.debugLogPath;
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
      .setDesc("Useful on iPhone when something breaks and you want the explanation immediately.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openLogOnError).onChange(async (value) => {
          this.plugin.settings.openLogOnError = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Note types" });

    this.plugin.settings.noteDefinitions.forEach((def, index) => {
      const section = containerEl.createDiv({ cls: "flexible-notes-section" });
      section.createEl("h4", { text: def.name || `Note type ${index + 1}` });

      new Setting(section)
        .setName("Enabled")
        .addToggle((toggle) =>
          toggle.setValue(def.enabled).onChange(async (value) => {
            def.enabled = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Name")
        .addText((text) =>
          text.setValue(def.name || "").onChange(async (value) => {
            def.name = value;
            def.id = this.plugin.makeId(value || def.id || `note-type-${index + 1}`);
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Template path")
        .setDesc("Vault-relative markdown file.")
        .addText((text) =>
          text.setValue(def.templatePath || "").onChange(async (value) => {
            def.templatePath = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Destination root")
        .setDesc("Example: Journal/Daily Reflection")
        .addText((text) =>
          text.setValue(def.destinationRoot || "").onChange(async (value) => {
            def.destinationRoot = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Folder pattern")
        .setDesc("Example: {{year}}/{{month}}")
        .addText((text) =>
          text.setValue(def.folderPattern || "").onChange(async (value) => {
            def.folderPattern = value || "{{year}}/{{month}}";
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Filename pattern")
        .setDesc("Example: {{day}} or {{date}}")
        .addText((text) =>
          text.setValue(def.filenamePattern || "").onChange(async (value) => {
            def.filenamePattern = value || "{{day}}";
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("If file exists")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("open", "Open existing")
            .addOption("skip", "Skip")
            .addOption("duplicate", "Create duplicate")
            .setValue(def.ifExists || "open")
            .onChange(async (value) => {
              def.ifExists = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(section)
        .setName("Open after create")
        .addToggle((toggle) =>
          toggle.setValue(def.openAfterCreate).onChange(async (value) => {
            def.openAfterCreate = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(section)
        .setName("Delete this note type")
        .setDesc("Removes it from settings. You may need to reload the plugin for command names to refresh.")
        .addButton((button) =>
          button.setButtonText("Delete").setWarning().onClick(async () => {
            this.plugin.settings.noteDefinitions.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    });

    new Setting(containerEl)
      .setName("Add note type")
      .setDesc("Creates a new flexible note definition.")
      .addButton((button) =>
        button.setButtonText("Add").setCta().onClick(async () => {
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

    containerEl.createEl("p", {
      text: "Note: after renaming or adding note types, reload the plugin so command names refresh cleanly.",
    });
  }
}
