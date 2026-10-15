// <copyright file="Issue2814GenerateAssemblyInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections
import System.IO
import Xunit

/// Regression coverage for issue #2814: the .NET SDK gates
/// `CoreGenerateAssemblyInfo` on `'$(Language)'=='VB' or 'C#'`, so a
/// `.gsproj` silently lost `AssemblyTitle`/`AssemblyProduct`/
/// `AssemblyCompany`/`AssemblyConfiguration`. That surfaced in the
/// migrated Oahu app, whose window title fell back from "Oahu" to
/// "Oahu.Foundation" because `ApplEnv.AssemblyTitle` found no
/// `AssemblyTitleAttribute` on the entry assembly and dropped into its
/// `GetExecutingAssembly().Location` fallback.
/// (cref:WriteGsharpAssemblyInfoTask) reproduces those attributes as
/// file-level G# `@assembly:` annotations (ADR-0143 §D).
open class Issue2814GenerateAssemblyInfoTests {
    @Fact
    func Render_SingleStringParameter_EmitsAssemblyAnnotation() {
        let item = TaskItem("System.Reflection.AssemblyTitleAttribute")
        item.SetMetadata("_Parameter1", "Oahu")
        Assert.Contains(
            "@assembly: System.Reflection.AssemblyTitleAttribute(\"Oahu\")",
            WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item}),
            StringComparison.Ordinal
        )
    }

    /// Issue #3679: the .NET SDK's `GetAssemblyAttributes` target turns
    /// every `<InternalsVisibleTo Include="X" />` msbuild item into
    /// an `@(AssemblyAttribute)` item whose identity is the suffix-less
    /// `System.Runtime.CompilerServices.InternalsVisibleTo`. Rendering it
    /// is how a `.gsproj` declares a friend assembly without hand-writing
    /// the annotation, so the exact spelling is a contract with the binder —
    /// see `Issue3679InternalsVisibleToMemberAccessTests`.
    @Fact
    func Render_InternalsVisibleToItem_EmitsFriendAssemblyAnnotation() {
        let item = TaskItem("System.Runtime.CompilerServices.InternalsVisibleTo")
        item.SetMetadata("_Parameter1", "GSharp.Core.Tests")
        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"GSharp.Core.Tests\")",
            WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item}),
            StringComparison.Ordinal
        )
    }

    @Fact
    func Render_MultiplePositionalParameters_KeepsDeclaredOrder() {
        let item = TaskItem("System.Reflection.AssemblyMetadataAttribute")
        item.SetMetadata("_Parameter2", "second")
        item.SetMetadata("_Parameter1", "first")
        Assert.Contains(
            "@assembly: System.Reflection.AssemblyMetadataAttribute(\"first\", \"second\")",
            WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item}),
            StringComparison.Ordinal
        )
    }

    @Fact
    func Render_NoParameters_EmitsBareAnnotation() {
        let item = TaskItem("System.Runtime.CompilerServices.DisableRuntimeMarshallingAttribute")
        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.DisableRuntimeMarshallingAttribute" + Environment.NewLine,
            WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item}),
            StringComparison.Ordinal
        )
    }

    @Fact
    func Render_NamedParameter_UsesGsharpColonSeparator() {
        // ADR-0080: named arguments are canonically 'name: value', not 'name = value'.
        let item = TaskItem("Some.CustomAttribute")
        item.SetMetadata("_Parameter1", "positional")
        item.SetMetadata("Description", "named")
        Assert.Contains(
            "@assembly: Some.CustomAttribute(\"positional\", Description: \"named\")",
            WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item}),
            StringComparison.Ordinal
        )
    }

    @Fact
    func Render_IsLiteralMetadata_EmitsValueAsRawCode() {
        let item = TaskItem("Some.CustomAttribute")
        item.SetMetadata("_Parameter1", "true")
        item.SetMetadata("_Parameter1_IsLiteral", "true")
        let rendered = WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item})
        Assert.Contains("@assembly: Some.CustomAttribute(true)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("_IsLiteral", rendered, StringComparison.Ordinal)
    }

    @Fact
    func Render_SkippedPositionalParameter_Throws() {
        let item = TaskItem("Some.CustomAttribute")
        item.SetMetadata("_Parameter1", "a")
        item.SetMetadata("_Parameter3", "c")
        Assert.Throws[ArgumentException](
            func () object? {
                return WriteGsharpAssemblyInfoTask.Render([]ITaskItem{item})
            }
        )
    }

    @Theory
    @InlineData("Probe $$Company", "\"Probe $$$$Company\"")
    @InlineData("back\\slash", "\"back\\\\slash\"")
    @InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")
    @InlineData("tab\there", "\"tab\\there\"")
    @InlineData("line\nbreak", "\"line\\nbreak\"")
    @InlineData("plain", "\"plain\"")
    func QuoteGsharpString_EscapesForGsharpLexer(value string, expected string) {
        Assert.Equal(expected, WriteGsharpAssemblyInfoTask.QuoteGsharpString(value))
    }

    @Fact
    func Execute_WritesFile_AndLeavesItUntouchedWhenContentIsUnchanged() {
        let dir = Path.Combine(Path.GetTempPath(), "gs2814-" + Guid.NewGuid().ToString("n"))
        let output = Path.Combine(dir, "nested", "Probe.AssemblyInfo.gs")
        try {
            let item = TaskItem("System.Reflection.AssemblyTitleAttribute")
            item.SetMetadata("_Parameter1", "Oahu")
            let task = WriteGsharpAssemblyInfoTask{
                BuildEngine: StubBuildEngine(),
                AssemblyAttributes: []ITaskItem{item},
                OutputFile: output
            }
            Assert.True(task.Execute())
            Assert.True(File.Exists(output))
            Assert.Contains("AssemblyTitleAttribute(\"Oahu\")", File.ReadAllText(output), StringComparison.Ordinal)
            // A second run with identical content must not rewrite the file, or
            // CoreCompile's Inputs check would see a spurious edit every build.
            let firstWrite = File.GetLastWriteTimeUtc(output)
            File.SetLastWriteTimeUtc(output, firstWrite.AddDays(-1))
            let marker = File.GetLastWriteTimeUtc(output)
            Assert.True(task.Execute())
            Assert.Equal(marker, File.GetLastWriteTimeUtc(output))
        } finally {
            if Directory.Exists(dir) {
                Directory.Delete(dir, recursive: true)
            }
        }
    }

    /// Issue #4932: when OutputFile is a filesystem root, Path.GetDirectoryName
    /// returns null. The task must skip creating a directory and fail at the
    /// write, as the C# task did, instead of throwing a NullReferenceException
    /// from an assertion on that null.
    @Fact
    func Execute_OutputFileIsFilesystemRoot_DoesNotThrowNullReference() {
        let root = Path.GetPathRoot(Path.GetTempPath())
        Assert.False(string.IsNullOrEmpty(root))
        Assert.Null(Path.GetDirectoryName(Path.GetFullPath(root!!)))
        let task = WriteGsharpAssemblyInfoTask{
            BuildEngine: StubBuildEngine(),
            AssemblyAttributes: Array.Empty[ITaskItem](),
            OutputFile: root
        }
        let ex = Record.Exception(
            func () {
                task.Execute()
            }
        )
        Assert.NotNull(ex)
        Assert.IsNotType[NullReferenceException](ex)
        Assert.True(ex is UnauthorizedAccessException || ex is IOException, "Unexpected exception: " + ex.ToString())
    }

    private class StubBuildEngine : IBuildEngine {
        prop ContinueOnError bool -> false
        prop LineNumberOfTaskNode int32 -> 0
        prop ColumnNumberOfTaskNode int32 -> 0
        prop ProjectFileOfTaskNode string -> string.Empty

        func BuildProjectFile(
            projectFileName string,
            targetNames[]string,
            globalProperties IDictionary,
            targetOutputs IDictionary
        ) bool -> true

        func LogCustomEvent(e CustomBuildEventArgs) { }

        func LogErrorEvent(e BuildErrorEventArgs) { }

        func LogMessageEvent(e BuildMessageEventArgs) { }

        func LogWarningEvent(e BuildWarningEventArgs) { }
    }
}
