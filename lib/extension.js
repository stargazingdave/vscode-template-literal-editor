'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const ts = require("typescript");
const os = require("os");
const path = require("path");
const fs_1 = require("fs");
const throttle = require("lodash.throttle");
// TODO Clean up defensive development guards (DEBUG, most try-catches, etc), as the extension seems to work without errors,
// and the vscode extension platform can mostly be trusted to do the right thing.
// TODO Clean up artificial delays to only those that are really needed, but testing those seems flaky.
const DEFAULT_TAG_LANGS = {
    javascript: 'javascript',
    html: 'html',
    css: 'css',
    sql: 'sql',
    gql: 'graphql',
    graphql: 'graphql',
    md: 'markdown',
    markdown: 'markdown',
    c: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    python: 'python',
    py: 'python',
    sh: 'shellscript',
    bash: 'shellscript',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml'
};
const SYNC_THROTTLE_MS = 100;
const isJsTsLanguageId = (lang) => lang === 'typescript' ||
    lang === 'typescriptreact' ||
    lang === 'javascript' ||
    lang === 'javascriptreact';
const DEBUG = false;
if (DEBUG) {
    process.on('unhandledRejection', (reason, _p) => {
        console.warn('UNHANDLED: %s', reason && reason.stack || reason);
    });
}
// Tracks all documents with open subdocuments
const activeDocuments = new Map();
// Remembers the previously picked language for convenience
let previouslyPickedLanguage = 'html';
// Guard against keeping Ctrl+Enter pressed
let opening = false;
// NOTE: One gets "TextEditor disposed" warnings if kept pressed, possibly indicative of some places needing a delay.
function activate(_context) {
    vscode.commands.registerTextEditorCommand('editor.openSubdocument', async (editor) => {
        if (opening) {
            return;
        }
        opening = true;
        try {
            // NOTE: Ctrl+Enter now toggles the subdocument when called on a subdocument, and so nested cases
            // like string literal > markdown > html block won't work. But they wouldn't work in any case due to
            // sync edits needing all three editors visible at the same time, and only two viewcolumns are currently used.
            for (let handle of activeDocuments.values()) {
                if (handle.subdoc === editor.document) {
                    // If called on a subdocument, close it, focus on original document, and sync cursor for convenience.
                    await handle.closeSubdocumentWithReason('Closed via toggling shortcut. This virtual document can be closed.');
                    // Early return
                    return;
                }
            }
            await findAndOpenLiteralUnderCursor(editor);
        }
        catch (err) {
            if (DEBUG) {
                if (err instanceof Error && err.stack) {
                    console.error('openSubdocument error: %s', err.stack);
                }
                else {
                    console.error('openSubdocument error: %s', err);
                }
            }
        }
        finally {
            opening = false;
        }
    });
    vscode.commands.registerTextEditorCommand('editor.closeSubdocuments', async (_editor) => {
        try {
            for (let handle of activeDocuments.values()) {
                // Alternatively could close only the document/subdocument that is open in the current editor, but let's close
                // them all for now.
                await handle.closeSubdocumentWithReason('Closed via shortcut. This virtual document can be closed.');
            }
        }
        catch (err) {
            if (DEBUG) {
                if (err instanceof Error && err.stack) {
                    console.error('openSubdocument error: %s', err.stack);
                }
                else {
                    console.error('openSubdocument error: %s', err);
                }
            }
        }
    });
    async function findAndOpenLiteralUnderCursor(editor) {
        try {
            const doc = editor.document;
            const cursorOffset = doc.offsetAt(editor.selection.active);
            let templateStart = 0;
            let templateEnd = 0;
            const config = vscode.workspace.getConfiguration('templateLiteralEditor.regexes');
            if (config.has(doc.languageId) && typeof config.get(doc.languageId) === 'string') {
                // Just iterates from the top of the document with a regexp. Could have a plugin system of some sort,
                // enabling custom parsers or expanding from the cursor, or some other scheme.
                const text = doc.getText();
                let matcher;
                try {
                    matcher = new RegExp(config.get(doc.languageId), 'g');
                }
                catch (err) {
                    if (err instanceof Error && err.stack) {
                        console.error('INVALID REGEX in templateLiteralEditor.regexes.%s: %s\n%s', doc.languageId, config.get(doc.languageId), err.stack);
                        await vscode.window.showErrorMessage(`Invalid regex in templateLiteralEditor.regexes.${doc.languageId}: ${config.get(doc.languageId)}\n${err && err.stack || err}`);
                    }
                    else {
                        console.error('INVALID REGEX in templateLiteralEditor.regexes.%s: %s\n%s', doc.languageId, config.get(doc.languageId), err);
                        await vscode.window.showErrorMessage(`Invalid regex in templateLiteralEditor.regexes.${doc.languageId}: ${config.get(doc.languageId)}\n${err}`);
                    }
                    throw err;
                }
                let match;
                while ((match = matcher.exec(text)) !== null) {
                    if (typeof match[1] === 'string' && typeof match[2] === 'string' && typeof match[3] === 'string') {
                        // Cursor at boundaries is ok, but only inner content is used as a template
                        if (match.index <= cursorOffset && cursorOffset <= matcher.lastIndex) {
                            // NOTE also surrogates work ok, as vscode column counter uses the same measurement as str.length
                            templateStart = match.index + match[1].length;
                            templateEnd = match.index + match[1].length + match[2].length;
                            break;
                        }
                        else if (matcher.lastIndex > cursorOffset) {
                            // Don't bother iterating the rest of the doc
                            break;
                        }
                    }
                }
            }
            else if (isJsTsLanguageId(doc.languageId)) {
                // Default JS and TS to proper tokenizing instead of regexp matching
                const source = ts.createSourceFile(doc.fileName, doc.getText(), ts.ScriptTarget.Latest, /*setParentNodes*/ true);
                // Find the outermost template literal
                let template;
                // getTokenAtPosition is not really public but widely used. May break in a future version.
                let token = ts.getTokenAtPosition(source, cursorOffset);
                while (token) {
                    if (token.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
                        token.kind === ts.SyntaxKind.TemplateExpression) {
                        template = token;
                    }
                    token = token.parent;
                }
                if (template) {
                    templateStart = template.getStart() + 1;
                    templateEnd = template.getEnd() - 1;
                }
            }
            else {
                // Omitted
            }
            if (templateStart !== 0) {
                const baseBehavior = readDefaultBehavior();
                const pragma = parseSingleLineTlePragma(doc, templateStart);
                // 1) choose language
                let pickedLanguage = null;
                if (pragma === null || pragma === void 0 ? void 0 : pragma.lang) {
                    pickedLanguage = pragma.lang;
                }
                else {
                    const languages = await vscode.languages.getLanguages();
                    const sorted = [previouslyPickedLanguage].concat(languages.filter(l => l !== previouslyPickedLanguage));
                    pickedLanguage = await vscode.window.showQuickPick(sorted, { placeHolder: 'Open in Language Mode' }) || null;
                }
                if (!pickedLanguage)
                    return; // user cancelled
                previouslyPickedLanguage = pickedLanguage;
                // 2) compute behavior from defaults + pragma
                const behavior = behaviorFrom(baseBehavior, pragma || null);
                // 3) go
                await activateSubdocument(pickedLanguage, editor, doc.positionAt(templateStart), doc.positionAt(templateEnd), behavior);
                return;
            }
            else {
                console.warn('Literal not found under cursor. If in error, please modify the source or templateLiteralEditor.regexes.%s configuration for your needs', doc.languageId);
                await vscode.window.showWarningMessage(`Literal not found under cursor. If in error, please modify the source or templateLiteralEditor.regexes.${doc.languageId} configuration for your needs. Please also consider submitting your improved regexes to the vscode-template-literal-editor repository.`, 
                // Open as modal, so that next enter closes the message quickly without needing a mouse.
                { modal: true });
            }
        }
        catch (err) {
            if (DEBUG) {
                if (err instanceof Error && err.stack) {
                    console.error('findAndOpenLiteralUnderCursor error: %s', err.stack);
                }
                else {
                    console.error('findAndOpenLiteralUnderCursor error: %s', err);
                }
            }
            throw err;
        }
    }
    async function activateSubdocument(language, editor, start, end, behavior) {
        const doc = editor.document;
        // Keep track of document range where template literal resides
        let templateRange = new vscode.Range(start, end);
        // // Calculate cursor position relative to viewport top for subdocument scroll to match
        // const cursorPosition = editor.selection.active;
        // await vscode.commands.executeCommand('cursorMove', {
        //     to: 'viewPortTop',
        //     select: false,
        // });
        // await vscode.commands.executeCommand('cursorMove', {
        //     to: 'wrappedLineStart',
        //     select: false,
        // });
        // const viewPortTopPosition = editor.selection.active;
        // // Move cursor back to where it was
        // await vscode.commands.executeCommand('cursorMove', {
        //     to: 'down',
        //     by: 'line',
        //     value: cursorPosition.line - viewPortTopPosition.line
        // });
        // editor.selection = new vscode.Selection(cursorPosition, cursorPosition);
        // Only one active subdocument per document allowed for simplicity.
        if (activeDocuments.has(doc)) {
            await activeDocuments.get(doc).closeSubdocumentWithReason('Reloading.');
            // TODO test if editor reference could be lost due to focus shifting if subdocument happens to be in the same group
        }
        // Create subdocument with chosen language.
        // Could be made configurable depending on template tag, keybinding, etc.
        // Create a temp file with correct extension for the language
        const ext = vscode.languages.getLanguages().then(() => {
            // crude but fine for known languages
            const map = {
                javascript: 'js', typescript: 'ts',
                html: 'html', css: 'css', sql: 'sql',
                c: 'c', cpp: 'cpp', python: 'py', shellscript: 'sh',
                json: 'json', xml: 'xml', markdown: 'md'
            };
            return map[language] || language;
        });
        const tempDir = path.join(os.tmpdir(), 'tle-subdocs');
        await fs_1.promises.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `tle-${Date.now()}-${Math.random().toString(36).slice(2)}.${await ext}`);
        // figure base indent columns once as you do already
        const lineInfo = doc.lineAt(templateRange.start.line);
        const baseCols = lineInfo.firstNonWhitespaceCharacterIndex;
        const openedRaw = doc.getText(templateRange);
        const nl = (doc.eol === vscode.EndOfLine.LF) ? '\n' : '\r\n';
        // REPLACE this:
        // let openedContent = stripIndentFrom(openedRaw, baseCols, doc.eol, editor.options);
        // WITH this:
        let openedContent = behavior.stripIndentOnOpen
            ? stripIndentFrom(openedRaw, baseCols, doc.eol, editor.options)
            : openedRaw;
        // keep your “exactly one leading blank line” normalization if you still want it:
        openedContent = openedContent.replace(/^(?:\r?\n)*/, nl);
        await fs_1.promises.writeFile(tempPath, openedContent, 'utf8');
        const subdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
        await vscode.languages.setTextDocumentLanguage(subdoc, language);
        activeDocuments.set(doc, {
            subdoc,
            behavior,
            async closeSubdocumentWithReason(_reason) { }
        });
        // Open subeditor in side by side view. Note that editor arrangement is fixed for simplicity.
        // NOTE: use these, as editor objects will be stale when refocused in tabs, and won't reflect group changes in any case.
        const editorViewColumn = editor.viewColumn;
        const subeditorViewColumn = editorViewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
        const subeditor = await vscode.window.showTextDocument(subdoc, subeditorViewColumn);
        await shortDelay();
        // Move cursor to proper position
        const targetPos = new vscode.Position(Math.max(editor.selection.active.line - templateRange.start.line, 0), Math.max(editor.selection.active.character - (editor.selection.active.line === templateRange.start.line ? templateRange.start.character : 0), 0));
        await moveActiveCursorTo(targetPos);
        // // How to scroll subdocument to match document viewport, and keep them in sync?
        // // Would need to measure viewport width to calculate wrapping lines, etc...
        // await vscode.commands.executeCommand('revealLine', {
        //     lineNumber: cursorSubposition.line,
        //     at: 'top'
        // });
        // // Proper implementation would leave dead space at top, so that lines would be matched even for small documents
        // await vscode.commands.executeCommand('editorScroll', {
        //     to: 'up',
        //     by: 'line',
        //     value: cursorPosition.line - viewPortTopPosition.line,
        // });
        // Center viewport if possible, for now, until line sync is possible
        await vscode.commands.executeCommand('revealLine', {
            lineNumber: subeditor.selection.active.line,
            at: 'center'
        });
        // await vscode.commands.executeCommand('editorScroll', {
        //     to: 'down',
        //     revealCursor: true,
        // });
        // const decorationType = vscode.window.createTextEditorDecorationType({
        //     isWholeLine: true,
        //     backgroundColor: '#222'
        // })
        // Experiment with cursor syncing
        // vscode.window.onDidChangeTextEditorSelection(event => {
        //     // NOTE should not use subeditor, but editor.document === subdoc
        //     if (event.textEditor === subeditor) {
        //
        //         (async() => {
        //
        //             // Experimental line highlighter (won't be native-like)
        //             // editor.setDecorations(
        //             //     decorationType, [
        //             //         new vscode.Range(
        //             //             templateRange.start.line + subeditor.selection.active.line,
        //             //             0,
        //             //             templateRange.start.line + subeditor.selection.active.line,
        //             //             1,
        //             //         )
        //             //     ]
        //             // )
        //
        //             // Experimental cursor sync (flickers)
        //             // await vscode.window.showTextDocument(doc, editor.viewColumn, /*preserveFocus*/ false);
        //             // await vscode.commands.executeCommand('cursorMove', {
        //             //     to: 'down',
        //             //     value: (templateRange.start.line + subeditor.selection.active.line) - editor.selection.active.line
        //             // });
        //             // await vscode.commands.executeCommand('cursorMove', {
        //             //     to: 'right',
        //             //     value: (subeditor.selection.active.line === 0 ? templateRange.start.character : 0) +
        //             //         subeditor.selection.active.character - editor.selection.active.character
        //             // });
        //             // await vscode.window.showTextDocument(subdoc, subeditor.viewColumn, /*preserveFocus*/ false);
        //
        //         })().catch(err => {
        //             if (DEBUG) {
        //                 console.error('didChangeSelection error: %s', err && err.stack || err);
        //             }
        //             throw err;
        //         });
        //     }
        // })
        /**
         * Handlers
         */
        const documentCloseListener = vscode.workspace.onDidCloseTextDocument(async (closedDoc) => {
            if (closedDoc === doc) {
                try {
                    await closeSubdocumentWithReason('Source document closed. This virtual document can be closed.');
                }
                catch (err) {
                    if (DEBUG) {
                        if (err instanceof Error && err.stack) {
                            console.error('documentCloseListener error: %s', err.stack);
                        }
                        else {
                            console.error('documentCloseListener error: %s', err);
                        }
                    }
                }
            }
        });
        const subdocumentCloseListener = vscode.workspace.onDidCloseTextDocument(async (closedDoc) => {
            if (closedDoc === subdoc) {
                try {
                    await closeSubdocumentWithReason('Subdocument closed. This virtual document can be closed.');
                }
                catch (err) {
                    if (DEBUG) {
                        if (err instanceof Error && err.stack) {
                            console.error('subdocumentCloseListener error: %s', err.stack);
                        }
                        else {
                            console.error('subdocumentCloseListener error: %s', err);
                        }
                    }
                }
            }
        });
        // These may prevent some sync issues, but may also annoy the user if they are unnecessary.
        // Changing e.g. encodings and line endings are mostly untested.
        // const configChangeListener = vscode.workspace.onDidChangeConfiguration(() => {
        //     disposeSubdocument('Workspace configuration changed. This virtual document can be closed.');
        // });
        // const optionsChangeListener = vscode.window.onDidChangeTextEditorOptions(({textEditor}) => {
        //     if (textEditor.document === doc || textEditor.document === subdoc) {
        //         disposeSubdocument('Document options changed. This virtual document can be closed.');
        //     }
        // });
        // Override ordinary save with saving of the original document.
        function newSaveOverride() {
            return vscode.commands.registerTextEditorCommand('workbench.action.files.save', async () => {
                var _a;
                try {
                    const active = (_a = vscode.window.activeTextEditor) === null || _a === void 0 ? void 0 : _a.document;
                    if (active === subdoc) {
                        await subdoc.save(); // save the temp file (lets format-on-save extensions run)
                    }
                    else {
                        await doc.save(); // save the parent TS/TSX file
                    }
                }
                catch (err) {
                    if (DEBUG) {
                        if (err instanceof Error && err.stack) {
                            console.error('Saving of document failed: %s', err.stack);
                        }
                        else {
                            console.error('Saving of document failed: %s', err);
                        }
                    }
                    saveOverride.dispose();
                }
            });
        }
        let saveOverride = newSaveOverride();
        // Always remove saveOverride when active editor changes, and set it again if focus is restored
        // NOTE: disposing saveOverride is very important, as othewise nothing can be saved in vscode, for any document.
        // So it is important to not fail setting this handler.
        const activeTextEditorChangeListener = vscode.window.onDidChangeActiveTextEditor(newEditor => {
            saveOverride.dispose();
            if (newEditor && newEditor.document === subdoc) {
                saveOverride = newSaveOverride();
            }
        });
        /**
         * Sync logic
         */
        // Keep track of change origins to avoid circular edits.
        let changeOrigin = null;
        const contentChangeListener = vscode.workspace.onDidChangeTextDocument(change => {
            // Suppress possible late edits
            if (changeOrigin === 'dispose') {
                return;
            }
            if (change.document === subdoc) {
                if (changeOrigin === 'document') {
                    // Document sync received, mark further edits as ordinary/unknown
                    changeOrigin = null;
                }
                else {
                    // We don't care about actual edits and partial templateRange synchronization,
                    // just copy everything in case there are changes
                    throttledSyncToDocument();
                }
            }
            else if (change.document === doc) {
                if (changeOrigin === 'subdocument') {
                    // Subdocument sync received, mark further edits as ordinary/unknown
                    changeOrigin = null;
                }
                else {
                    // Track only simple changes in original document (does not touch template boundaries)
                    const isValid = change.contentChanges.every(({ range: changeRange }) => {
                        return (changeRange.end.isBefore(templateRange.start) ||
                            changeRange.start.isAfter(templateRange.end) ||
                            templateRange.contains(changeRange));
                    });
                    if (!isValid) {
                        // We don't track complex edits in original document, let's close
                        // subdocument for safety. We don't want to retokenize the document and
                        // try to infer which template is which.
                        closeSubdocumentWithReason('Source document has been modified. This virtual editor can be closed.').catch(err => {
                            if (DEBUG) {
                                console.error('onDidChangeTextDocument error: %s', err && err.stack || err);
                            }
                        });
                    }
                    else {
                        // Defer sync until all contentChanges are processed, so that changes, content and templateRange match
                        let needsSync = false;
                        change.contentChanges.forEach(({ range: changeRange, text: changeText }) => {
                            if (changeRange.start.isAfter(templateRange.end)) {
                                // Simplest case: No templateRange update needed for changes below template
                                if (DEBUG) {
                                    // Not actually needed, but can be enabled to see problems earlier
                                    needsSync = true;
                                }
                            }
                            else if (changeRange.end.isBefore(templateRange.start)) {
                                // General case before template, a bit complex due to depending on both changeRange and
                                // changeText line count etc
                                // TODO experiment with doc.eol from vscode 1.11
                                const insertedLines = changeText.split(/\r\n|\r|\n/);
                                const lineDiff = insertedLines.length - (changeRange.end.line - changeRange.start.line + 1);
                                let charDiff = 0;
                                if (changeRange.end.line < templateRange.start.line) {
                                    // Simple change above template, just count lines and move the templateRange if needed
                                }
                                else {
                                    // Change touches the template start line
                                    // first remove changeRange chars, it does not matter if there are multiple lines
                                    charDiff -= (changeRange.end.character - changeRange.start.character);
                                    // then add new changeText chars, only last line counts
                                    // NOTE also surrogates work ok, as vscode column counter uses the same measurement as str.length
                                    charDiff += insertedLines[insertedLines.length - 1].length;
                                    if (insertedLines.length > 1) {
                                        // If a line break is introduced, push to beginning of line
                                        charDiff -= changeRange.start.character;
                                    }
                                }
                                if (lineDiff || charDiff) {
                                    // Move templateRange accordingly
                                    templateRange = new vscode.Range(
                                    // Start row and col may change
                                    templateRange.start.line + lineDiff, templateRange.start.character + charDiff, 
                                    // End row may change
                                    templateRange.end.line + lineDiff, 
                                    // End col changes only if the templateRange is a single line
                                    templateRange.isSingleLine ?
                                        templateRange.end.character + charDiff :
                                        templateRange.end.character);
                                    if (DEBUG) {
                                        // Not actually needed, but can be enabled to see problems earlier
                                        needsSync = true;
                                    }
                                }
                            }
                            else if (templateRange.contains(changeRange)) {
                                // General case inside template, also a bit complex due to depending on both changeRange and
                                // changeText line count etc
                                // TODO experiment with doc.eol from vscode 1.11
                                const insertedLines = changeText.split(/\r\n|\r|\n/);
                                const lineDiff = insertedLines.length - (changeRange.end.line - changeRange.start.line + 1);
                                let charDiff = 0;
                                if (changeRange.end.line < templateRange.end.line) {
                                    // Simple change above template end, just count lines and move the templateRange end
                                    // if needed
                                }
                                else {
                                    // Change touches the template end line
                                    // first remove changeRange chars, it does not matter if there are multiple lines
                                    charDiff -= (changeRange.end.character - changeRange.start.character);
                                    // then add new changeText chars, only last line counts
                                    // NOTE also surrogates work ok, as vscode column counter uses the same measurement as str.length
                                    charDiff += insertedLines[insertedLines.length - 1].length;
                                    if (insertedLines.length > 1) {
                                        // If a line break is introduced, the last line starts at the beginning of line
                                        charDiff -= changeRange.start.character;
                                    }
                                }
                                // Move templateRange accordingly
                                templateRange = new vscode.Range(
                                // Start row and col stay the same
                                templateRange.start.line, templateRange.start.character, 
                                // End row and col may change
                                templateRange.end.line + lineDiff, templateRange.end.character + charDiff);
                                needsSync = true;
                            }
                        });
                        if (needsSync) {
                            throttledSyncToSubdocument();
                        }
                    }
                }
            }
        });
        // Throttle sync document edits, so that editing the subdocument stays quick.
        // As there are async functions involved which may have a delay, may need guarding transactions if errors start to appear.
        // NOTE: latest vscode edits (v1.22->) are slower than previously, so guards against re-entrancy instead of
        // increasing throttling, to keep it snappy
        let isSyncingToDocument = false;
        const throttledSyncToDocument = throttle(async () => {
            if (isSyncingToDocument) {
                if (DEBUG) {
                    console.warn('throttledSyncToDocument overlap, will defer');
                }
                // Calls function again to not miss edits in case this is the last invocation in this stall.
                throttledSyncToDocument();
                return;
            }
            isSyncingToDocument = true;
            try {
                // We have to always take a new reference to the editor, as it may have been hidden
                // and a new editor may need to be created.
                const newEditor = await vscode.window.showTextDocument(doc, editorViewColumn, /*preserveFocus*/ true);
                // pull per-literal behavior we stored
                const { behavior } = activeDocuments.get(doc);
                // Build indent based on the START of the line (not the backtick column),
                // then push N extra levels.
                let indent = '';
                let closeIndentStr = '';
                const raw = subdoc.getText();
                const nl = (doc.eol === vscode.EndOfLine.LF) ? '\n' : '\r\n';
                let content = raw;
                if (behavior.offsetIndentOnSync) {
                    const lineInfo = doc.lineAt(templateRange.start.line);
                    const baseCols = lineInfo.firstNonWhitespaceCharacterIndex;
                    const baseIndentStr = makeIndentString(newEditor.options, baseCols);
                    const tabSize = typeof newEditor.options.tabSize === 'number' ? newEditor.options.tabSize : 4;
                    const oneLevel = (newEditor.options.insertSpaces === false) ? '\t' : ' '.repeat(tabSize);
                    const extra = oneLevel.repeat(Math.max(0, behavior.extraIndentLevels));
                    indent = baseIndentStr + extra; // code lines
                    closeIndentStr = baseIndentStr; // closing backtick one level less than code
                    // indent the code
                    content = applyIndentOffsetTo(raw, indent, doc.eol);
                    // ensure a trailing newline, then place closing backtick indent
                    const trimmed = content.replace(/[ \t]+$/g, '');
                    content = trimmed.endsWith(nl) ? trimmed : trimmed + nl;
                    content += closeIndentStr;
                }
                const editOk = await newEditor.edit(editBuilder => {
                    changeOrigin = 'subdocument';
                    editBuilder.replace(templateRange, content);
                    const newLines = content.split(/\r\n|\r|\n/);
                    templateRange = new vscode.Range(templateRange.start.line, templateRange.start.character, templateRange.start.line + newLines.length - 1, (newLines.length === 1 ? templateRange.start.character : 0) +
                        (newLines.length ? newLines[newLines.length - 1].length : 0));
                });
                if (!editOk)
                    throw new Error('Sync to document did not succeed');
            }
            catch (err) {
                if (DEBUG) {
                    if (err instanceof Error && err.stack) {
                        console.error('DOC SYNC ERROR %s', err.stack);
                    }
                    else {
                        console.error('DOC SYNC ERROR %s', err);
                    }
                }
                try {
                    await closeSubdocumentWithReason('Source document could not be synced with subdocument. This virtual editor can be closed.');
                }
                catch (err2) {
                    if (DEBUG) {
                        if (err2 instanceof Error && err2.stack) {
                            console.error('throttledSyncToDocument error: %s', err2.stack);
                        }
                        else {
                            console.error('throttledSyncToDocument error: %s', err2);
                        }
                    }
                }
            }
            finally {
                isSyncingToDocument = false;
            }
        }, SYNC_THROTTLE_MS);
        // Throttle sync subdocument edits, so that editing document stays snappy
        // This might be a bit more costly due to enabled language services in subdocument, so increase
        // delay if needed. Delay could be made configurable.
        // NOTE: If a large delay is needed, everything here may need to be guarded against subdocument
        // closing before or in the middle of execution. But let's keep this simple and quick for now.
        // NOTE: latest vscode edits (v1.22->) are slower than previously, so guards against re-entrancy instead of
        // increasing throttling, to keep it snappy
        let isSyncingToSubdocument = false;
        const throttledSyncToSubdocument = throttle(async () => {
            if (isSyncingToSubdocument) {
                if (DEBUG) {
                    console.warn('throttledSyncToSubdocument overlap, will defer');
                }
                // Calls function again to not miss edits in case this is the last invocation in this stall.
                throttledSyncToSubdocument();
                return;
            }
            isSyncingToSubdocument = true;
            try {
                // We have to always take a new reference to the editor, as it may have been hidden
                // and a new editor may need to be created.
                const newSubeditor = await vscode.window.showTextDocument(subdoc, subeditorViewColumn, /*preserveFocus*/ true);
                const editOk = await newSubeditor.edit(editBuilder => {
                    // We don't care about actual edits and partial templateRange synchronization,
                    // just copy everything in case there are changes. This may have a cost of
                    // calculating decorations etc again, but can be revisited if a need arises.
                    // Mark next edit as originating from document. Does not consider multiple edits
                    // at the same time to both documents.
                    changeOrigin = 'document';
                    const totalRange = subdoc.validateRange(new vscode.Range(0, 0, 100000, 100000));
                    // We copy whole literal to subdoc. Depends on both documents having the same config.
                    editBuilder.replace(totalRange, doc.getText(templateRange));
                });
                if (!editOk) {
                    // If there are multiple edits, they may not succeed, and then templateRange will be out of sync.
                    // Better to fail then.
                    throw new Error('Sync to subdocument did not succeed');
                }
            }
            catch (err) {
                if (DEBUG) {
                    if (err instanceof Error && err.stack) {
                        console.error('SUBDOC SYNC ERROR %s', err.stack);
                    }
                    else {
                        console.error('SUBDOC SYNC ERROR %s', err);
                    }
                }
                try {
                    await closeSubdocumentWithReason('Subdocument could not be synced with original document. This virtual editor can be closed.');
                }
                catch (err2) {
                    if (DEBUG) {
                        if (err2 instanceof Error && err2.stack) {
                            console.error('throttledSyncToSubdocument error: %s', err2.stack);
                        }
                        else {
                            console.error('throttledSyncToSubdocument error: %s', err2);
                        }
                    }
                }
            }
            finally {
                isSyncingToSubdocument = false;
            }
        }, SYNC_THROTTLE_MS);
        async function closeSubdocumentWithReason(reason) {
            try {
                if (DEBUG) {
                    console.log('DISPOSING: %s', reason);
                }
                changeOrigin = 'dispose';
                contentChangeListener.dispose();
                documentCloseListener.dispose();
                subdocumentCloseListener.dispose();
                saveOverride.dispose();
                activeTextEditorChangeListener.dispose();
                activeDocuments.delete(doc);
                // Close untitled subdocs via action, moves focus so may pipe quick keypresses to wrong doc unfortunately
                await closeSubeditor();
                // Cleanup temp directory
                try {
                    const dir = path.dirname(subdoc.uri.fsPath);
                    if (path.basename(dir).startsWith('tle-')) {
                        await removeDirRecursive(dir);
                    }
                }
                catch (e) {
                    if (DEBUG)
                        console.warn('Temp cleanup failed:', e);
                }
            }
            catch (err) {
                if (DEBUG) {
                    if (err instanceof Error && err.stack) {
                        console.error('closeSubdocumentWithReason error: %s', err.stack);
                    }
                    else {
                        console.error('closeSubdocumentWithReason error: %s', err);
                    }
                }
                throw err;
            }
        }
        // async function markSubdocumentAsTainted(reason: string) {
        //     if (vscode.workspace.textDocuments.indexOf(subdoc) >= 0) {
        //         try {
        //             let newSubeditor = await vscode.window.showTextDocument(
        //                 subdoc, subeditorColumn, /*preserveFocus*/ true
        //             );
        //             let ok = await newSubeditor.edit(builder => {
        //                 const totalRange = subdoc.validateRange(new vscode.Range(0, 0, 100000, 100000));
        //                 builder.replace(totalRange, reason || 'This virtual editor can be closed.');
        //             });
        //             if (!ok) {
        //                 throw new Error('Dispose edit could not succeed');
        //             }
        //         } catch (err) {
        //             if (DEBUG) {
        //                 console.error('DISPOSE ERR %s', err && err.stack || err);
        //             }
        //         }
        //     }
        // }
        async function closeSubeditor() {
            if (vscode.workspace.textDocuments.indexOf(subdoc) >= 0) {
                // Note: subdocument may be visible in multiple editors, but luckily reverting seems to close all of them.
                try {
                    // Save current focus, if available and valid
                    let returnDoc;
                    let returnViewColumn;
                    let returnPos;
                    // Artificial delay, trying to ensure correct editor is got when closing the subdoc.
                    await shortDelay();
                    const activeTextEditor = vscode.window.activeTextEditor;
                    if (activeTextEditor) {
                        if (activeTextEditor.document === subdoc) {
                            // Common case: closing subeditor via Ctrl+Enter or Ctrl+Shift+Backspace when subeditor is in focus.
                            // Focus on original document afterwards.
                            returnDoc = doc;
                            returnViewColumn = editorViewColumn;
                            // Sync also cursor in this case
                            returnPos = new vscode.Position(templateRange.start.line + activeTextEditor.selection.active.line, (activeTextEditor.selection.active.line === 0 ? templateRange.start.character : 0) +
                                activeTextEditor.selection.active.character);
                        }
                        else {
                            // Move focus otherwise back to where it was, if available
                            returnDoc = activeTextEditor.document;
                            returnViewColumn = activeTextEditor.viewColumn;
                        }
                    }
                    // Move focus temporarily to subdocument. Try to minimize time for the focus to be in wrong doc as the
                    // user may be typing.
                    await vscode.window.showTextDocument(subdoc, subeditorViewColumn, /*preserveFocus*/ false);
                    // Artificial delay, to prevent "TextEditor disposed" warning (in Extension Development Host only).
                    await shortDelay();
                    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === subdoc) {
                        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                    }
                    await shortDelay();
                    // May need a bit longer delay for larger documents in some environments, as the revealed editor is initializing?
                    // Get rid of these when VS Code race conditions are sorted out and focus is shifted
                    // reliably to original document on larger subdocuments.
                    // await new Promise(resolve => {
                    //     setTimeout(() => {
                    //         resolve();
                    //     }, 100);
                    // });
                    // Move focus back to where it was, if available
                    if (returnDoc && returnViewColumn) {
                        await vscode.window.showTextDocument(returnDoc, returnViewColumn, /*preserveFocus*/ false);
                        // Artificial delay, to prevent "TextEditor disposed" warning (in Extension Development Host only).
                        await shortDelay();
                        if (returnPos) {
                            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === doc) {
                                await moveActiveCursorTo(returnPos);
                                // Don't center viewport for now, until line sync is possible
                                if (vscode.window.activeTextEditor) {
                                    // await vscode.commands.executeCommand('revealLine', {
                                    //     lineNumber: vscode.window.activeTextEditor.selection.active.line,
                                    //     at: 'center'
                                    // });
                                    // await vscode.commands.executeCommand('editorScroll', {
                                    //     to: 'down',
                                    //     revealCursor: true,
                                    // });
                                    await shortDelay();
                                }
                            }
                        }
                    }
                }
                catch (err) {
                    if (DEBUG) {
                        if (err instanceof Error && err.stack) {
                            console.error('DISPOSE ERR %s', err.stack);
                        }
                        else {
                            console.error('DISPOSE ERR %s', err);
                        }
                    }
                }
            }
        }
        // We are ready, update document disposer to the proper one
        activeDocuments.set(doc, { subdoc, behavior, closeSubdocumentWithReason });
    }
}
exports.activate = activate;
async function moveActiveCursorTo(targetPosition) {
    const activeTextEditor = vscode.window.activeTextEditor;
    if (activeTextEditor && activeTextEditor.document) {
        let targetPos = activeTextEditor.document.validatePosition(targetPosition);
        const lineDelta = targetPos.line - activeTextEditor.selection.active.line;
        if (lineDelta) {
            await vscode.commands.executeCommand('cursorMove', {
                to: 'down',
                by: 'line',
                value: lineDelta
            });
        }
        let charDelta = targetPos.character - activeTextEditor.selection.active.character;
        // Let's limit iteration count in case target cannot be reached for some reason
        for (let iter = 0; charDelta && iter < 100; iter++) {
            if (DEBUG && iter === 90) {
                console.warn('moveActiveCursorTo too many iterations, giving up.');
            }
            // Note: Revisit this in case VS Code behavior changes in the future.
            await vscode.commands.executeCommand('cursorMove', {
                to: 'left',
                by: 'character',
                value: -charDelta // Capped at wrapped line start and end for some reason? So iterate when needed.
            });
            charDelta = targetPos.character - activeTextEditor.selection.active.character;
        }
    }
}
async function shortDelay() {
    // await new Promise(resolve => { setImmediate(resolve); });
    // Deferring to the beginning of next event loop run seems too short for extension api implementation.
    // There should be a ping of some sort, or should this delay be configurable, to please slow environments?
    await new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, 0);
    });
}
async function removeDirRecursive(dir) {
    var _a, _b;
    try {
        const entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const p = path.join(dir, e);
            if ((_b = (_a = e).isDirectory) === null || _b === void 0 ? void 0 : _b.call(_a)) {
                await removeDirRecursive(p);
            }
            else {
                await fs_1.promises.unlink(p).catch(() => { });
            }
        }
        await fs_1.promises.rmdir(dir).catch(() => { });
    }
    catch {
        // ignore
    }
}
function readDefaultBehavior() {
    var _a;
    const cfg = vscode.workspace.getConfiguration('templateLiteralEditor');
    return {
        stripIndentOnOpen: cfg.get('stripIndentOnOpen', false),
        offsetIndentOnSync: cfg.get('offsetIndentOnSync', false),
        extraIndentLevels: Math.max(0, (_a = cfg.get('extraIndentLevels', 1)) !== null && _a !== void 0 ? _a : 1),
    };
}
function makeIndentString(editorOpts, columns) {
    const insertSpaces = editorOpts.insertSpaces !== false;
    const tabSize = typeof editorOpts.tabSize === 'number' ? editorOpts.tabSize : 4;
    if (!insertSpaces) {
        const tabs = Math.floor(columns / tabSize);
        const spaces = columns % tabSize;
        return '\t'.repeat(tabs) + ' '.repeat(spaces);
    }
    return ' '.repeat(columns);
}
function applyIndentOffsetTo(text, indent, eol) {
    const nl = (eol === vscode.EndOfLine.LF) ? '\n' : '\r\n';
    return text
        .split(/\r\n|\r|\n/)
        .map(line => (line.length ? indent + line : line))
        .join(nl);
}
function stripIndentFrom(text, maxColumns, eol, opts) {
    const tabSize = typeof opts.tabSize === 'number' ? opts.tabSize : 4;
    const nl = (eol === vscode.EndOfLine.LF) ? '\n' : '\r\n';
    return text
        .split(/\r\n|\r|\n/)
        .map(line => {
        if (!line.length)
            return line;
        let i = 0, cols = 0;
        while (i < line.length && (line[i] === ' ' || line[i] === '\t') && cols < maxColumns) {
            if (line[i] === ' ') {
                cols += 1;
                i++;
            }
            else {
                cols += tabSize;
                i++;
            }
        }
        return line.slice(i);
    })
        .join(nl);
}
/** Parse a single-line tle pragma either:
 *   // tle: lang=c, offset=true, levels=1
 * or
 *   /* tle: lang=c, offset=true, levels=1 *\/
 * It looks ONLY on the same line (left of backtick) OR the immediately previous non-empty line.
 */
function parseSingleLineTlePragma(doc, templateStart) {
    const backtickPos = doc.positionAt(templateStart);
    // collect up to 2 places: same line (left of backtick) + previous non-empty line
    const spots = [];
    spots.push(doc.lineAt(backtickPos.line).text.slice(0, backtickPos.character));
    // previous non-empty line (only one)
    let prev = backtickPos.line - 1;
    while (prev >= 0) {
        const t = doc.lineAt(prev).text;
        if (t.trim().length === 0) {
            prev--;
            continue;
        }
        spots.push(t);
        break;
    }
    // regex that finds `tle:` then captures until end of comment/line (single-line only)
    const re = /tle:\s*([^*/\r\n]+)/i;
    for (const s of spots) {
        const m = re.exec(s);
        if (!m)
            continue;
        const raw = m[1]; // e.g. "lang=c, offset=true, levels=1"
        const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
        const out = {};
        for (const p of parts) {
            const [kRaw, vRaw] = p.split('=').map(x => (x !== null && x !== void 0 ? x : '').trim());
            const k = kRaw.toLowerCase();
            const v = vRaw;
            if (!k)
                continue;
            if (k === 'lang') {
                // Accept a VS Code language id or a shorthand key from DEFAULT_TAG_LANGS
                const direct = v;
                const mapped = DEFAULT_TAG_LANGS[v.toLowerCase()];
                out.lang = mapped || direct;
            }
            else if (k === 'offset') {
                const vl = v.toLowerCase();
                out.offset = (vl === 'true' || vl === '1');
            }
            else if (k === 'levels') {
                const n = Number(v);
                if (!Number.isNaN(n) && n >= 0)
                    out.levels = n;
            }
            else if (k === 'strip' || k === 'stripindent') {
                const vl = v.toLowerCase();
                out.strip = (vl === 'true' || vl === '1');
            }
        }
        return out;
    }
    return null;
}
function behaviorFrom(defaults, pragma) {
    var _a, _b, _c;
    return {
        stripIndentOnOpen: (_a = pragma === null || pragma === void 0 ? void 0 : pragma.strip) !== null && _a !== void 0 ? _a : defaults.stripIndentOnOpen,
        offsetIndentOnSync: (_b = pragma === null || pragma === void 0 ? void 0 : pragma.offset) !== null && _b !== void 0 ? _b : defaults.offsetIndentOnSync,
        extraIndentLevels: (_c = pragma === null || pragma === void 0 ? void 0 : pragma.levels) !== null && _c !== void 0 ? _c : defaults.extraIndentLevels,
    };
}
// Cleanup on exit, to avoid stale editors on reload. Earlier this wouldn't work, and still cannot be tested on Extension
// Development Host, but now seems to usually work ok (at least something clears the editors).
async function deactivate(_context) {
    try {
        for (let handle of activeDocuments.values()) {
            await handle.closeSubdocumentWithReason('Extension deactivated. This virtual document can be closed.');
        }
    }
    catch (err) {
        if (DEBUG) {
            if (err instanceof Error && err.stack) {
                console.error('DEACTIVATE error: %s', err.stack);
            }
            else {
                console.error('DEACTIVATE error: %s', err);
            }
        }
    }
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map