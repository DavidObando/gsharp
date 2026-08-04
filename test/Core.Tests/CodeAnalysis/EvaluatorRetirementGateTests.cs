// <copyright file="EvaluatorRetirementGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0156 Phase 3b.3 (#3176): the tree-walking evaluator's entry surface
/// (<c>Compilation.Evaluate</c> and the <c>Evaluator</c> constructors) is
/// <c>[Obsolete]</c>, and — because warnings-as-errors is global — every
/// remaining legitimate caller carries an explicit
/// <c>#pragma warning disable CS0618</c> with a justification comment. That
/// suppression list IS the authoritative Phase 3c retirement inventory, so
/// this gate pins it: any NEW suppression (a new evaluator caller) fails
/// here and must instead use the emitted oracle
/// (<c>test/Shared/EmittedOracle.cs</c>) — see issue #3176.
/// </summary>
public class EvaluatorRetirementGateTests
{
    /// <summary>
    /// The pinned CS0618 suppression census (repo-relative paths, '/'
    /// separators, sorted ordinally). Every entry is one of: the evaluator's
    /// product host (SessionEngine), an interp-vs-emit parity harness, an
    /// evaluator-machinery pin, or an issue-pinned divergence (#3236).
    /// Phase 3c retires the evaluator by burning this list down to empty;
    /// entries may be REMOVED as callers migrate, never added.
    /// </summary>
    private static readonly IReadOnlyList<string> AllowedSuppressionFiles = new[]
    {
        // Not an evaluator caller: pre-existing suppression for the BCL's
        // obsolete OperandType.InlinePhi. The gate pins ALL CS0618
        // suppressions so no evaluator caller can hide behind a new one.
        "src/Core/CodeAnalysis/Emit/MaxStackTracker.cs",
        "src/Repl/Engine/SessionEngine.cs",
        "test/Compiler.Tests/Emit/Issue1714StringZeroValueEmitTests.cs",
        "test/Compiler.Tests/Emit/Issue2853EllipsisLoopCaptureTests.cs",
        "test/Compiler.Tests/Emit/Issue2854TopLevelEllipsisLoopCaptureTests.cs",
        "test/Compiler.Tests/Emit/Issue2906ExhaustiveSwitchReturnEmitTests.cs",
        "test/Compiler.Tests/Emit/Issue2907IteratorLoopCaptureTests.cs",
        "test/Compiler.Tests/Emit/Issue2914ConstantPatternSwitchLoweringTests.cs",
        "test/Compiler.Tests/Emit/Issue2927NullableSequenceElementTypeTests.cs",
        "test/Compiler.Tests/Emit/Issue2928TupleFunctionParityTests.cs",
        "test/Core.Tests/CodeAnalysis/Binding/ByRefEvaluationTests.cs",
        "test/Core.Tests/CodeAnalysis/Binding/Issue1654EvaluateNoCfgDumpTests.cs",
        "test/Core.Tests/CodeAnalysis/Binding/Issue2188ReferenceConstrainedTypeParamObjectTests.cs",
        "test/Core.Tests/CodeAnalysis/Binding/Issue2535NullableReferenceConversionTests.cs",
        "test/Core.Tests/CodeAnalysis/Binding/Issue698DeinitBinderTests.cs",
        "test/Core.Tests/CodeAnalysis/Emit/AsyncInterpVsEmitParityTests.cs",
        "test/Core.Tests/CodeAnalysis/Emit/Issue2544LiftedUnaryOperatorTests.cs",
        "test/Core.Tests/LanguageConformance/AddressBookSampleTests.cs",
        "test/Core.Tests/LanguageConformance/AspirationalSamplesTests.cs",
        "test/Core.Tests/LanguageConformance/CountWordsSampleTests.cs",
        "test/Interpreter.Tests/Adr0156EmitToMemorySpikeTests.cs",
        "test/Interpreter.Tests/Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests.cs",
        "test/Interpreter.Tests/Issue2896StructObjectOverrideTests.cs",
        "test/Interpreter.Tests/Issue2921LambdaBodyDefiniteReturnInterpreterTests.cs",
        "test/Interpreter.Tests/Issue2938DelegateExceptionDiagnosticTests.cs",
        "test/Interpreter.Tests/Issue2953ProtectedReturnFallthroughInterpreterTests.cs",
        "test/Interpreter.Tests/Issue2984MainEntryPointInterpreterTests.cs",
        "test/Interpreter.Tests/Issue2990ClrDelegateBoundaryTests.cs",
        "test/Interpreter.Tests/Issue2991LambdaMethodIdentityTests.cs",
        "test/Interpreter.Tests/Issue3058OutParameterMemberDefiniteAssignmentTests.cs",
        "test/Interpreter.Tests/Issue3140OutParameterWriteBackParityTests.cs",
        "tools/cs2gs/Cs2Gs.Tests/Issue1721PrinterPrecedenceTests.cs",
    };

    private static readonly Regex SuppressionLine = new(
        @"^\s*#pragma\s+warning\s+disable\b[^\r\n]*\bCS0618\b",
        RegexOptions.Multiline | RegexOptions.Compiled);

    [Fact]
    public void Cs0618_Suppressions_Match_The_Pinned_Evaluator_Retirement_Inventory()
    {
        var repoRoot = FindRepoRoot();
        var found = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var topDir in new[] { "src", "test", "tools" })
        {
            var root = Path.Combine(repoRoot, topDir);
            if (!Directory.Exists(root))
            {
                continue;
            }

            foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
                if (relative.Split('/').Any(segment => segment is "obj" or "bin" or "out"))
                {
                    continue;
                }

                if (SuppressionLine.IsMatch(File.ReadAllText(file)))
                {
                    found.Add(relative);
                }
            }
        }

        var expected = new SortedSet<string>(AllowedSuppressionFiles, StringComparer.Ordinal);
        var added = found.Except(expected).ToList();
        var removed = expected.Except(found).ToList();

        Assert.True(
            added.Count == 0 && removed.Count == 0,
            "The CS0618 (Compilation.Evaluate / Evaluator obsolescence) suppression census changed."
            + (added.Count > 0
                ? "\nNEW suppressions (new tree-walking-evaluator callers are forbidden — use the"
                  + " emitted oracle in test/Shared/EmittedOracle.cs instead; see issue #3176):\n  "
                  + string.Join("\n  ", added)
                : string.Empty)
            + (removed.Count > 0
                ? "\nRemoved suppressions (great — a caller migrated; delete its entry from"
                  + " EvaluatorRetirementGateTests.AllowedSuppressionFiles to re-pin the census):\n  "
                  + string.Join("\n  ", removed)
                : string.Empty));
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(EvaluatorRetirementGateTests).Assembly.Location)!);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("GSharp.sln not found above the test assembly.");
    }
}
