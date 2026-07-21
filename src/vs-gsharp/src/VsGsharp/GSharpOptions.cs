using System.ComponentModel;
using Microsoft.VisualStudio.Shell;

namespace GSharp.VisualStudio;

public sealed class GSharpOptions : DialogPage
{
    [Category("Language Server")]
    [DisplayName("Server path")]
    [Description("Optional path to GSharp.LanguageServer.dll. Leave empty to use the bundled server.")]
    public string ServerPath { get; set; } = string.Empty;

    [Category("Language Server")]
    [DisplayName("Enable server log")]
    [Description("Write a detailed language-server log.")]
    public bool EnableServerLog { get; set; }

    [Category("Language Server")]
    [DisplayName("Wait for debugger")]
    [Description("Wait for a debugger to attach when starting the language server.")]
    public bool WaitForDebugger { get; set; }

    [Category("Language Server")]
    [DisplayName("Server log path")]
    [Description("Optional language-server log path.")]
    public string ServerLogPath { get; set; } = string.Empty;

    [Category("Language Server")]
    [DisplayName("Cold-start cache")]
    [Description("Persist project metadata used to accelerate language-server startup. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool EnableColdStartCache { get; set; } = true;

    [Category("Formatting")]
    [DisplayName("Indent size")]
    [Description("Number of spaces per indentation level. Restart the language server after changing this option.")]
    [DefaultValue(4)]
    public int IndentSize { get; set; } = 4;

    [Category("Formatting")]
    [DisplayName("Use tabs")]
    [Description("Use tabs instead of spaces. Restart the language server after changing this option.")]
    [DefaultValue(false)]
    public bool UseTabs { get; set; }

    [Category("Diagnostics")]
    [DisplayName("Diagnostics while typing")]
    [Description("Update diagnostics while typing instead of only when opening or saving a document. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool EnableDiagnosticsOnType { get; set; } = true;

    [Category("Completion")]
    [DisplayName("Trigger completion on dot")]
    [Description("Automatically show completion after typing a dot. Manual completion remains available. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool TriggerCompletionOnDot { get; set; } = true;

    [Category("CodeLens")]
    [DisplayName("Reference counts")]
    [Description("Show reference-count CodeLens entries. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool EnableReferenceCodeLens { get; set; } = true;

    [Category("Inlay Hints")]
    [DisplayName("Parameter names")]
    [Description("Show parameter names at call sites. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool EnableParameterNameInlayHints { get; set; } = true;

    [Category("Inlay Hints")]
    [DisplayName("Inferred types")]
    [Description("Show inferred types for variables without explicit type clauses. Restart the language server after changing this option.")]
    [DefaultValue(true)]
    public bool EnableTypeInlayHints { get; set; } = true;
}
