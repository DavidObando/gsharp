// <copyright file="Issue2637ExtensionInterfaceClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2637: imported generic extension methods must infer through the
/// receiver's implemented-interface closure.
/// </summary>
public class Issue2637ExtensionInterfaceClosureTests
{
    [Fact]
    public void OahuJobScheduler_ConcurrentDictionarySelect_Binds()
    {
        const string source = """
            package Oahu.Cli.App.Jobs
            import System.Collections.Concurrent
            import System.Collections.Generic
            import System.Linq

            class JobLifecycle { prop Id string }
            class PersistedJob { prop Id string }

            func PersistActiveJobs(jobs ConcurrentDictionary[string, JobLifecycle]) {
                let snapshot = jobs.Select((kv KeyValuePair[string, JobLifecycle]) -> PersistedJob{Id: kv.Value.Id}).ToList()
            }
            """;

        AssertBindsWithDefaultAndMetadataResolvers(source);
    }

    [Fact]
    public void OahuAppShell_ReadOnlyListSelect_Binds()
    {
        const string source = """
            package Oahu.Cli.Tui.Shell
            import System.Collections.Generic
            import System.Linq

            interface ITabScreen { prop Title string { get; } }

            func Render(tabs IReadOnlyList[ITabScreen]) {
                let titles = tabs.Select((t ITabScreen) -> t.Title).ToArray()
            }
            """;

        AssertBindsWithDefaultAndMetadataResolvers(source);
    }

    private static void AssertBindsWithDefaultAndMetadataResolvers(string source)
    {
        Assert.Empty(BindErrors(source));

        using var resolver = ReferenceResolver.WithReferences(
            new[]
            {
                typeof(object).Assembly.Location,
                typeof(ConcurrentDictionary<,>).Assembly.Location,
                typeof(List<>).Assembly.Location,
                typeof(Enumerable).Assembly.Location,
            }.Distinct(StringComparer.OrdinalIgnoreCase));
        Assert.Empty(BindErrors(source, resolver));
    }

    private static ImmutableArray<Diagnostic> BindErrors(string source, ReferenceResolver resolver = null)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var global = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(global, resolver);
        return tree.Diagnostics
            .Concat(global.Diagnostics)
            .Concat(program.Diagnostics)
            .Where(static diagnostic => diagnostic.IsError)
            .ToImmutableArray();
    }
}
