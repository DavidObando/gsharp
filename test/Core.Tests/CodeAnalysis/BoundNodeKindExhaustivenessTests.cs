// <copyright file="BoundNodeKindExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Validates that every <see cref="BoundNodeKind"/> value is explicitly
/// handled (or intentionally allowlisted) in each of the four emit/lowering
/// dispatch switches. A missing case surfaces as a test failure naming the
/// kind, so adding a new <see cref="BoundNodeKind"/> without updating the
/// consuming switches is impossible without a red test.
/// </summary>
public class BoundNodeKindExhaustivenessTests
{
    /// <summary>
    /// Map from <see cref="BoundNodeKind"/> enum-value name to the C# class
    /// name(s) used in <c>case</c> patterns. Most map 1:1 by prepending
    /// "Bound"; a few share a CLR class (e.g. <c>AwaitYieldPoint</c> and
    /// <c>AwaitResumePoint</c> both map to <c>BoundAwaitSequencePoint</c>).
    /// </summary>
    private static readonly Dictionary<string, string[]> KindToClassNames = BuildKindToClassMap();

    // Source paths relative to the repo root.
    private const string EmitExpressionsPath = "src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions.cs";
    private const string EmitStatementsPath = "src/Core/CodeAnalysis/Emit/MethodBodyEmitter.cs";
    private const string SpillSequenceSpillerPath = "src/Core/CodeAnalysis/Lowering/Async/SpillSequenceSpiller.cs";

    // ──────────────────────────────────────────────────────────────────────
    //  Allowlists: kinds that legitimately never appear in a given switch.
    //  Each entry documents the reason (lowered away, wrong category, etc.).
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Kinds the EmitExpression switch never sees — patterns, statements,
    /// and expression kinds lowered away before emit.
    /// </summary>
    private static readonly HashSet<string> EmitExpressionAllowlist = new(new[]
    {
        // Pattern kinds — matched inside EmitPatternSwitchStatement, not EmitExpression.
        "ConstantPattern",
        "DiscardPattern",
        "TypePattern",
        "PropertyPattern",
        "PropertyPatternField",
        "RelationalPattern",
        "ListPattern",

        // Statement kinds — dispatched via EmitStatement, not EmitExpression.
        "BlockStatement",
        "VariableDeclaration",
        "IfStatement",
        "ForInfiniteStatement",
        "ForEllipsisStatement",
        "ForRangeStatement",
        "LabelStatement",
        "GotoStatement",
        "ConditionalGotoStatement",
        "ReturnStatement",
        "ExpressionStatement",
        "TryStatement",
        "ThrowStatement",
        "PatternSwitchStatement",
        "GoStatement",
        "ChannelSendStatement",
        "SelectStatement",
        "ScopeStatement",
        "AwaitForRangeStatement",
        "YieldStatement",

        // Helper / annotation kinds that are not expressions.
        "PatternSwitchArm",
        "SwitchExpressionArm",
        "Attribute",

        // Lowered-away expression kinds: always removed by earlier passes.
        "AwaitExpression",              // lowered by async rewriter
        "SpillSequenceExpression",      // removed by SpillSequenceSpiller
        "AwaitYieldPoint",              // synthetic async markers (statement-like)
        "AwaitResumePoint",             // synthetic async markers (statement-like)
        "InterpolatedStringExpression", // lowered to BoundBlockExpression by InterpolatedStringHandlerLowerer
    });

    /// <summary>
    /// Kinds the EmitStatement switch never sees.
    /// </summary>
    private static readonly HashSet<string> EmitStatementAllowlist = new(new[]
    {
        // Expression kinds — dispatched via EmitExpression.
        "ErrorExpression",
        "LiteralExpression",
        "VariableExpression",
        "AssignmentExpression",
        "UnaryExpression",
        "BinaryExpression",
        "CallExpression",
        "ConversionExpression",
        "ImportedCallExpression",
        "ImportedInstanceCallExpression",
        "ConstrainedStaticCallExpression",
        "ArrayCreationExpression",
        "MapLiteralExpression",
        "MapDeleteExpression",
        "IndexExpression",
        "IndexAssignmentExpression",
        "LenExpression",
        "CapExpression",
        "AppendExpression",
        "StructLiteralExpression",
        "ConstructorCallExpression",
        "UserInstanceCallExpression",
        "FieldAccessExpression",
        "FieldAssignmentExpression",
        "PropertyAccessExpression",
        "PropertyAssignmentExpression",
        "NullConditionalAccessExpression",
        "TupleLiteralExpression",
        "TupleElementAccessExpression",
        "FunctionLiteralExpression",
        "MethodGroupExpression",
        "ClrMethodGroupExpression",
        "IndirectCallExpression",
        "InterpolatedStringExpression",
        "ClrConstructorCallExpression",
        "ClrPropertyAccessExpression",
        "ClrPropertyAssignmentExpression",
        "ClrBinaryOperatorExpression",
        "ClrUnaryOperatorExpression",
        "ClrConversionCallExpression",
        "ClrIndexExpression",
        "ClrIndexAssignmentExpression",
        "ClrEventSubscriptionExpression",
        "EventSubscriptionExpression",
        "AwaitExpression",
        "SwitchExpression",
        "BlockExpression",
        "AddressOfExpression",
        "DereferenceExpression",
        "StateMachineAwaitOnCompleted",
        "StateMachineBuilderMoveNext",
        "SpillSequenceExpression",
        "DefaultExpression",
        "ClrStaticCallExpression",
        "ConditionalAddressExpression",
        "ConditionalExpression",
        "IndirectAssignmentExpression",
        "TypeOfExpression",
        "MakeChannelExpression",
        "ChannelReceiveExpression",
        "ChannelCloseExpression",
        "IsExpression",
        "AsExpression",
        "ConstructorChainingExpression",

        // Pattern kinds.
        "ConstantPattern",
        "DiscardPattern",
        "TypePattern",
        "PropertyPattern",
        "PropertyPatternField",
        "RelationalPattern",
        "ListPattern",

        // Helper / annotation kinds.
        "PatternSwitchArm",
        "SwitchExpressionArm",
        "Attribute",

        // Lowered-away statement kinds (lowered to gotos by Lowerer).
        "IfStatement",
        "ForInfiniteStatement",
        "ForEllipsisStatement",
        "ForRangeStatement",
        "AwaitForRangeStatement",
    });

    /// <summary>
    /// Kinds the SpillExpression switch never sees — statement kinds, pattern kinds,
    /// and annotation kinds.
    /// </summary>
    private static readonly HashSet<string> SpillExpressionAllowlist = new(new[]
    {
        // Statement kinds — not expressions.
        "BlockStatement",
        "VariableDeclaration",
        "IfStatement",
        "ForInfiniteStatement",
        "ForEllipsisStatement",
        "ForRangeStatement",
        "LabelStatement",
        "GotoStatement",
        "ConditionalGotoStatement",
        "ReturnStatement",
        "ExpressionStatement",
        "TryStatement",
        "ThrowStatement",
        "PatternSwitchStatement",
        "GoStatement",
        "ChannelSendStatement",
        "SelectStatement",
        "ScopeStatement",
        "AwaitForRangeStatement",
        "YieldStatement",

        // Pattern kinds.
        "ConstantPattern",
        "DiscardPattern",
        "TypePattern",
        "PropertyPattern",
        "PropertyPatternField",
        "RelationalPattern",
        "ListPattern",

        // Helper / annotation kinds.
        "PatternSwitchArm",
        "SwitchExpressionArm",
        "Attribute",

        // Synthetic async markers (statement-like).
        "AwaitYieldPoint",
        "AwaitResumePoint",
    });

    /// <summary>
    /// Kinds the RewriteStatementToList switch never sees — expression kinds,
    /// pattern kinds, annotation kinds, and statement kinds that are lowered
    /// away before the async spill pass.
    /// </summary>
    private static readonly HashSet<string> RewriteStatementAllowlist = new(new[]
    {
        // Expression kinds — not statements.
        "ErrorExpression",
        "LiteralExpression",
        "VariableExpression",
        "AssignmentExpression",
        "UnaryExpression",
        "BinaryExpression",
        "CallExpression",
        "ConversionExpression",
        "ImportedCallExpression",
        "ImportedInstanceCallExpression",
        "ConstrainedStaticCallExpression",
        "ArrayCreationExpression",
        "MapLiteralExpression",
        "MapDeleteExpression",
        "IndexExpression",
        "IndexAssignmentExpression",
        "LenExpression",
        "CapExpression",
        "AppendExpression",
        "StructLiteralExpression",
        "ConstructorCallExpression",
        "UserInstanceCallExpression",
        "FieldAccessExpression",
        "FieldAssignmentExpression",
        "PropertyAccessExpression",
        "PropertyAssignmentExpression",
        "NullConditionalAccessExpression",
        "TupleLiteralExpression",
        "TupleElementAccessExpression",
        "FunctionLiteralExpression",
        "MethodGroupExpression",
        "ClrMethodGroupExpression",
        "IndirectCallExpression",
        "InterpolatedStringExpression",
        "ClrConstructorCallExpression",
        "ClrPropertyAccessExpression",
        "ClrPropertyAssignmentExpression",
        "ClrBinaryOperatorExpression",
        "ClrUnaryOperatorExpression",
        "ClrConversionCallExpression",
        "ClrIndexExpression",
        "ClrIndexAssignmentExpression",
        "ClrEventSubscriptionExpression",
        "EventSubscriptionExpression",
        "AwaitExpression",
        "SwitchExpression",
        "BlockExpression",
        "AddressOfExpression",
        "DereferenceExpression",
        "StateMachineAwaitOnCompleted",
        "StateMachineBuilderMoveNext",
        "SpillSequenceExpression",
        "DefaultExpression",
        "ClrStaticCallExpression",
        "ConditionalAddressExpression",
        "ConditionalExpression",
        "IndirectAssignmentExpression",
        "TypeOfExpression",
        "MakeChannelExpression",
        "ChannelReceiveExpression",
        "ChannelCloseExpression",
        "IsExpression",
        "AsExpression",
        "ConstructorChainingExpression",

        // Pattern kinds.
        "ConstantPattern",
        "DiscardPattern",
        "TypePattern",
        "PropertyPattern",
        "PropertyPatternField",
        "RelationalPattern",
        "ListPattern",

        // Helper / annotation kinds.
        "PatternSwitchArm",
        "SwitchExpressionArm",
        "Attribute",

        // Lowered-away statement kinds (lowered to gotos by Lowerer before async pass).
        "ForInfiniteStatement",
        "ForEllipsisStatement",
        "ForRangeStatement",
        "AwaitForRangeStatement",
    });

    [Fact]
    public void EmitExpression_HandlesAllBoundNodeKinds()
    {
        var allKinds = GetAllBoundNodeKindNames();
        var source = ReadSourceFile(EmitExpressionsPath);
        var handledKinds = ExtractHandledKinds(source, "private void EmitExpression(BoundExpression expression)");
        AssertExhaustive(allKinds, handledKinds, EmitExpressionAllowlist, "EmitExpression");
    }

    [Fact]
    public void EmitStatement_HandlesAllBoundNodeKinds()
    {
        var allKinds = GetAllBoundNodeKindNames();
        var source = ReadSourceFile(EmitStatementsPath);
        var handledKinds = ExtractHandledKinds(source, "private void EmitStatement(BoundStatement statement)");
        AssertExhaustive(allKinds, handledKinds, EmitStatementAllowlist, "EmitStatement");
    }

    [Fact]
    public void SpillExpression_HandlesAllBoundNodeKinds()
    {
        var allKinds = GetAllBoundNodeKindNames();
        var source = ReadSourceFile(SpillSequenceSpillerPath);
        var handledKinds = ExtractHandledKinds(source, "private BoundSpillSequenceExpression SpillExpression(BoundExpression expression)");
        AssertExhaustive(allKinds, handledKinds, SpillExpressionAllowlist, "SpillExpression");
    }

    [Fact]
    public void RewriteStatementToList_HandlesAllBoundNodeKinds()
    {
        var allKinds = GetAllBoundNodeKindNames();
        var source = ReadSourceFile(SpillSequenceSpillerPath);
        var handledKinds = ExtractHandledKinds(source, "private bool RewriteStatementToList(BoundStatement statement");
        AssertExhaustive(allKinds, handledKinds, RewriteStatementAllowlist, "RewriteStatementToList");
    }

    [Fact]
    public void SelfTest_SyntheticKindDetected()
    {
        // Guard against the test silently passing because its regex broke or
        // its allowlists swallow everything. Inject a synthetic kind and
        // assert the helper fails with a message naming it.
        var allKinds = GetAllBoundNodeKindNames();
        allKinds.Add("SyntheticTestKind");

        var source = ReadSourceFile(EmitExpressionsPath);
        var handledKinds = ExtractHandledKinds(source, "private void EmitExpression(BoundExpression expression)");

        var missing = GetMissingKinds(allKinds, handledKinds, EmitExpressionAllowlist);
        Assert.Contains("SyntheticTestKind", missing);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────────────────────────────

    internal static HashSet<string> GetAllBoundNodeKindNames()
    {
        return new HashSet<string>(Enum.GetNames(typeof(BoundNodeKind)));
    }

    private static string ReadSourceFile(string relativePath)
    {
        var repoRoot = FindRepoRoot();
        var fullPath = Path.Combine(repoRoot, relativePath);
        Assert.True(File.Exists(fullPath), $"Source file not found: {fullPath}");
        return File.ReadAllText(fullPath);
    }

    /// <summary>
    /// Extracts the set of <see cref="BoundNodeKind"/> names handled by a
    /// switch statement inside the named method. Recognizes two patterns:
    /// <list type="bullet">
    /// <item><c>case BoundXyzExpression …:</c> (type-pattern arms)</item>
    /// <item><c>case BoundNodeKind.Xyz:</c> (enum-value arms)</item>
    /// </list>
    /// </summary>
    internal static HashSet<string> ExtractHandledKinds(string source, string methodSignature)
    {
        // Find the method body start.
        var sigIndex = source.IndexOf(methodSignature, StringComparison.Ordinal);
        Assert.True(sigIndex >= 0, $"Method signature not found: {methodSignature}");

        // Find the opening brace of the method.
        var bodyStart = source.IndexOf('{', sigIndex);
        Assert.True(bodyStart >= 0, "Opening brace not found after method signature.");

        // Walk braces to find the matching close brace.
        var bodyEnd = FindMatchingBrace(source, bodyStart);
        var methodBody = source.Substring(bodyStart, bodyEnd - bodyStart + 1);

        var handled = new HashSet<string>();

        // Pattern 1: `case BoundXyzExpression …:` or `case BoundXyzStatement …:`
        // or `case BoundXyz:` (any Bound-prefixed type).
        var typePatternRegex = new Regex(
            @"case\s+(Bound\w+)\b",
            RegexOptions.Multiline);

        foreach (Match m in typePatternRegex.Matches(methodBody))
        {
            var className = m.Groups[1].Value;
            var kinds = MapClassNameToKinds(className);
            foreach (var kind in kinds)
            {
                handled.Add(kind);
            }
        }

        // Pattern 2: `case BoundNodeKind.Xyz:`
        var enumPatternRegex = new Regex(
            @"case\s+BoundNodeKind\.(\w+)\s*:",
            RegexOptions.Multiline);

        foreach (Match m in enumPatternRegex.Matches(methodBody))
        {
            handled.Add(m.Groups[1].Value);
        }

        return handled;
    }

    internal static List<string> GetMissingKinds(
        HashSet<string> allKinds,
        HashSet<string> handledKinds,
        HashSet<string> allowlist)
    {
        return allKinds
            .Where(k => !handledKinds.Contains(k) && !allowlist.Contains(k))
            .OrderBy(k => k)
            .ToList();
    }

    private static void AssertExhaustive(
        HashSet<string> allKinds,
        HashSet<string> handledKinds,
        HashSet<string> allowlist,
        string switchName)
    {
        var missing = GetMissingKinds(allKinds, handledKinds, allowlist);
        Assert.True(
            missing.Count == 0,
            $"{switchName} is missing case arms for the following BoundNodeKind values: {string.Join(", ", missing)}");
    }

    private static int FindMatchingBrace(string source, int openBraceIndex)
    {
        var depth = 0;
        for (var i = openBraceIndex; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }

        throw new InvalidOperationException("Unmatched opening brace.");
    }

    /// <summary>
    /// Maps a C# class name (e.g. <c>BoundAwaitSequencePoint</c>) to the
    /// <see cref="BoundNodeKind"/> values it represents.
    /// </summary>
    private static string[] MapClassNameToKinds(string className)
    {
        // Collect all kinds that map to this class name (handles multi-kind
        // classes like BoundAwaitSequencePoint → AwaitYieldPoint + AwaitResumePoint).
        var results = new List<string>();
        foreach (var kvp in KindToClassNames)
        {
            foreach (var cn in kvp.Value)
            {
                if (cn == className)
                {
                    results.Add(kvp.Key);
                }
            }
        }

        if (results.Count > 0)
        {
            return results.ToArray();
        }

        // Fallback: strip "Bound" prefix and return.
        if (className.StartsWith("Bound", StringComparison.Ordinal))
        {
            var kindName = className.Substring("Bound".Length);
            return new[] { kindName };
        }

        return Array.Empty<string>();
    }

    /// <summary>
    /// Builds the map from <see cref="BoundNodeKind"/> name to CLR class name(s).
    /// Most entries follow the convention <c>Xyz</c> → <c>BoundXyz</c>. Only
    /// exceptions are listed explicitly.
    /// </summary>
    private static Dictionary<string, string[]> BuildKindToClassMap()
    {
        var map = new Dictionary<string, string[]>();
        foreach (var name in Enum.GetNames(typeof(BoundNodeKind)))
        {
            // Default convention.
            map[name] = new[] { "Bound" + name };
        }

        // Overrides for non-standard mappings.
        // BoundAwaitSequencePoint uses AwaitYieldPoint / AwaitResumePoint kinds.
        map["AwaitYieldPoint"] = new[] { "BoundAwaitSequencePoint" };
        map["AwaitResumePoint"] = new[] { "BoundAwaitSequencePoint" };

        // BoundAttribute uses the Attribute kind.
        map["Attribute"] = new[] { "BoundAttribute" };

        return map;
    }

    private static string FindRepoRoot()
    {
        var dir = Path.GetDirectoryName(typeof(BoundNodeKindExhaustivenessTests).Assembly.Location);
        while (!string.IsNullOrEmpty(dir))
        {
            if (File.Exists(Path.Combine(dir, ".config", "dotnet-tools.json")))
            {
                return dir;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return Environment.CurrentDirectory;
    }
}
