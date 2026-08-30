// <copyright file="Issue2814GenerateAssemblyInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Regression coverage for issue #2814: the .NET SDK gates
/// <c>CoreGenerateAssemblyInfo</c> on <c>'$(Language)'=='VB' or 'C#'</c>, so a
/// <c>.gsproj</c> silently lost <c>AssemblyTitle</c>/<c>AssemblyProduct</c>/
/// <c>AssemblyCompany</c>/<c>AssemblyConfiguration</c>. That surfaced in the
/// migrated Oahu app, whose window title fell back from "Oahu" to
/// "Oahu.Foundation" because <c>ApplEnv.AssemblyTitle</c> found no
/// <c>AssemblyTitleAttribute</c> on the entry assembly and dropped into its
/// <c>GetExecutingAssembly().Location</c> fallback.
/// <see cref="WriteGsharpAssemblyInfoTask"/> reproduces those attributes as
/// file-level G# <c>@assembly:</c> annotations (ADR-0143 §D).
/// </summary>
public class Issue2814GenerateAssemblyInfoTests
{
    [Fact]
    public void Render_SingleStringParameter_EmitsAssemblyAnnotation()
    {
        var item = new TaskItem("System.Reflection.AssemblyTitleAttribute");
        item.SetMetadata("_Parameter1", "Oahu");

        Assert.Contains(
            "@assembly: System.Reflection.AssemblyTitleAttribute(\"Oahu\")",
            WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Issue #3679: the .NET SDK's <c>GetAssemblyAttributes</c> target turns
    /// every <c>&lt;InternalsVisibleTo Include="X" /&gt;</c> msbuild item into
    /// an <c>@(AssemblyAttribute)</c> item whose identity is the suffix-less
    /// <c>System.Runtime.CompilerServices.InternalsVisibleTo</c>. Rendering it
    /// is how a <c>.gsproj</c> declares a friend assembly without hand-writing
    /// the annotation, so the exact spelling is a contract with the binder —
    /// see <c>Issue3679InternalsVisibleToMemberAccessTests</c>.
    /// </summary>
    [Fact]
    public void Render_InternalsVisibleToItem_EmitsFriendAssemblyAnnotation()
    {
        var item = new TaskItem("System.Runtime.CompilerServices.InternalsVisibleTo");
        item.SetMetadata("_Parameter1", "GSharp.Core.Tests");

        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"GSharp.Core.Tests\")",
            WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Render_MultiplePositionalParameters_KeepsDeclaredOrder()
    {
        var item = new TaskItem("System.Reflection.AssemblyMetadataAttribute");
        item.SetMetadata("_Parameter2", "second");
        item.SetMetadata("_Parameter1", "first");

        Assert.Contains(
            "@assembly: System.Reflection.AssemblyMetadataAttribute(\"first\", \"second\")",
            WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Render_NoParameters_EmitsBareAnnotation()
    {
        var item = new TaskItem("System.Runtime.CompilerServices.DisableRuntimeMarshallingAttribute");

        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.DisableRuntimeMarshallingAttribute" + Environment.NewLine,
            WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Render_NamedParameter_UsesGsharpColonSeparator()
    {
        // ADR-0080: named arguments are canonically 'name: value', not 'name = value'.
        var item = new TaskItem("Some.CustomAttribute");
        item.SetMetadata("_Parameter1", "positional");
        item.SetMetadata("Description", "named");

        Assert.Contains(
            "@assembly: Some.CustomAttribute(\"positional\", Description: \"named\")",
            WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Render_IsLiteralMetadata_EmitsValueAsRawCode()
    {
        var item = new TaskItem("Some.CustomAttribute");
        item.SetMetadata("_Parameter1", "true");
        item.SetMetadata("_Parameter1_IsLiteral", "true");

        string rendered = WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item });

        Assert.Contains("@assembly: Some.CustomAttribute(true)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("_IsLiteral", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_SkippedPositionalParameter_Throws()
    {
        var item = new TaskItem("Some.CustomAttribute");
        item.SetMetadata("_Parameter1", "a");
        item.SetMetadata("_Parameter3", "c");

        Assert.Throws<ArgumentException>(
            () => WriteGsharpAssemblyInfoTask.Render(new ITaskItem[] { item }));
    }

    [Theory]

    // G# interpolates '$ident'/'${expr}' in EVERY interpreted string, so a bare
    // '$' must be escaped as '$$' — a difference from C# that a CodeDom-based
    // emitter would get wrong.
    [InlineData("Probe $Company", "\"Probe $$Company\"")]
    [InlineData("back\\slash", "\"back\\\\slash\"")]
    [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
    [InlineData("tab\there", "\"tab\\there\"")]
    [InlineData("line\nbreak", "\"line\\nbreak\"")]
    [InlineData("plain", "\"plain\"")]
    public void QuoteGsharpString_EscapesForGsharpLexer(string value, string expected)
    {
        Assert.Equal(expected, WriteGsharpAssemblyInfoTask.QuoteGsharpString(value));
    }

    [Fact]
    public void Execute_WritesFile_AndLeavesItUntouchedWhenContentIsUnchanged()
    {
        string dir = Path.Combine(Path.GetTempPath(), "gs2814-" + Guid.NewGuid().ToString("n"));
        string output = Path.Combine(dir, "nested", "Probe.AssemblyInfo.gs");
        try
        {
            var item = new TaskItem("System.Reflection.AssemblyTitleAttribute");
            item.SetMetadata("_Parameter1", "Oahu");

            var task = new WriteGsharpAssemblyInfoTask
            {
                BuildEngine = new StubBuildEngine(),
                AssemblyAttributes = new ITaskItem[] { item },
                OutputFile = output,
            };

            Assert.True(task.Execute());
            Assert.True(File.Exists(output));
            Assert.Contains("AssemblyTitleAttribute(\"Oahu\")", File.ReadAllText(output), StringComparison.Ordinal);

            // A second run with identical content must not rewrite the file, or
            // CoreCompile's Inputs check would see a spurious edit every build.
            DateTime firstWrite = File.GetLastWriteTimeUtc(output);
            File.SetLastWriteTimeUtc(output, firstWrite.AddDays(-1));
            DateTime marker = File.GetLastWriteTimeUtc(output);

            Assert.True(task.Execute());
            Assert.Equal(marker, File.GetLastWriteTimeUtc(output));
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }

    private sealed class StubBuildEngine : IBuildEngine
    {
        public bool ContinueOnError => false;

        public int LineNumberOfTaskNode => 0;

        public int ColumnNumberOfTaskNode => 0;

        public string ProjectFileOfTaskNode => string.Empty;

        public bool BuildProjectFile(
            string projectFileName,
            string[] targetNames,
            System.Collections.IDictionary globalProperties,
            System.Collections.IDictionary targetOutputs) => true;

        public void LogCustomEvent(CustomBuildEventArgs e)
        {
        }

        public void LogErrorEvent(BuildErrorEventArgs e)
        {
        }

        public void LogMessageEvent(BuildMessageEventArgs e)
        {
        }

        public void LogWarningEvent(BuildWarningEventArgs e)
        {
        }
    }
}
