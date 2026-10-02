// <copyright file="Issue4681ChannelsNullPassThroughTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4681: the channels runtime wrote <c>value!</c> on unconstrained
/// <c>T</c> values. That is a compile-time no-op in C#, but cs2gs translates it
/// to a fail-fast <c>!!</c>, so the migrated runtime threw a
/// <c>NullReferenceException</c> on <c>ch &lt;- nil; &lt;-ch</c> for
/// <c>chan[string?]</c> and in <c>select</c> send arms (the #4612 class: a
/// maybe-null value of an unconstrained type parameter hits a throwing
/// assertion). The C# is written so no null-forgiving operator touches an
/// element value; this test migrates the real runtime sources and rejects any
/// <c>!!</c> on one.
/// </summary>
public class Issue4681ChannelsNullPassThroughTests
{
    // The element values the runtime moves, by every name it moves them under:
    // locals and fields (value, taken, sendValue, received, pending), a
    // ReceiveResult's Value, and the zero value of T / TResult.
    private static readonly Regex ElementValueAssertion = new(
        @"(?:(?<![\w])(?:this\.)?(?:value|taken|sendValue|received|pending|item)|\.Value|(?<![\w])default\(T\w*\))!!",
        RegexOptions.Compiled);

    /// <summary>
    /// The discriminating witness (ADR-0154): migrate every source file of the
    /// real runtime project, exactly as the self-migration does, and reject a
    /// fail-fast bridge on an element value. It fails on the pre-fix sources
    /// (five sites that survive the polish pass, plus the ones it strips).
    /// </summary>
    [Fact]
    public async Task ChannelsRuntimeSelfMigration_NeverAssertsAnElementValue()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "src", "Sdk", "Gsharp.Runtime.Channels", "Gsharp.Runtime.Channels.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            "Gsharp.Runtime.Channels should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var offending = new List<string>();
        var sawChanCore = false;
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(
                new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context));
            string name = Path.GetFileName(document.FilePath);
            sawChanCore |= name == "Chan{T}.cs";

            foreach (string raw in printed.Split('\n'))
            {
                string line = raw.Trim();
                if (line.StartsWith("//", StringComparison.Ordinal) || line.StartsWith("///", StringComparison.Ordinal))
                {
                    continue;
                }

                if (ElementValueAssertion.IsMatch(line))
                {
                    offending.Add(name + ": " + line);
                }
            }
        }

        Assert.True(sawChanCore, "The channels runtime should include Chan{T}.cs.");
        Assert.True(
            offending.Count == 0,
            "A fail-fast `!!` on a channel element value throws on `nil` in the migrated runtime:"
                + Environment.NewLine + string.Join(Environment.NewLine, offending));
    }
}
