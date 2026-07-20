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
    [Description("Persist project metadata used to accelerate language-server startup.")]
    [DefaultValue(true)]
    public bool EnableColdStartCache { get; set; } = true;

    [Category("Formatting")]
    [DisplayName("Indent size")]
    [Description("Number of spaces per indentation level.")]
    [DefaultValue(4)]
    public int IndentSize { get; set; } = 4;

    [Category("Formatting")]
    [DisplayName("Use tabs")]
    [DefaultValue(false)]
    public bool UseTabs { get; set; }
}
