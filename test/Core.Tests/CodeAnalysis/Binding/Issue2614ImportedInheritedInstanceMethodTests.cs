// <copyright file="Issue2614ImportedInheritedInstanceMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2614ImportedInheritedInstanceMethodTests
{
    [Fact]
    public void OahuBclShapes_BindWithoutGS0159()
    {
        var result = BindWithFrameworkReferences("""
            import System.Collections.Concurrent
            import System.Security.AccessControl

            class ModalRequest { }

            func Probe(
                queue ConcurrentQueue[ModalRequest],
                security FileSecurity,
                rule FileSystemAccessRule
            ) {
                var value ModalRequest? = nil
                queue.TryDequeue(&value)
                security.RemoveAccessRule(rule)
            }
            """);

        Assert.DoesNotContain(result, diagnostic => diagnostic.Id == "GS0159");
        Assert.Empty(result);
    }

    [Fact]
    public void ImportedLookup_MissingDerivedSignature_WalksBasesAndDefaultInterfaces()
    {
        Assert.Single(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            new AggregateFailingType(typeof(RootCommand)),
            nameof(Command.SetAction)));
        Assert.Single(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            new AggregateFailingType(typeof(DerivedFileSecurity<int>)),
            nameof(FileSecurity<int>.RemoveAccessRule)));
        Assert.Single(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            new AggregateFailingType(typeof(QueueWithDefault)),
            nameof(IQueueDefault.TryDequeue)));
    }

    [Fact]
    public void UnknownImportedInstanceMethod_StillReportsGS0159()
    {
        var diagnostics = BindWithFrameworkReferences("""
            import System.Collections.Concurrent

            func Probe(queue ConcurrentQueue[string]) {
                queue.NotAQueueMethod()
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0159", diagnostic.Id);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> BindWithFrameworkReferences(string source)
    {
        using var references = ReferenceResolver.WithReferences(
            Directory.EnumerateFiles(
                RuntimeEnvironment.GetRuntimeDirectory(),
                "*.dll",
                SearchOption.TopDirectoryOnly));
        var compilation = new Compilation(
            references,
            SyntaxTree.Parse(SourceText.From(source)));
        return compilation.SyntaxTrees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();
    }

    private class Command
    {
        public void SetAction()
        {
        }
    }

    private sealed class RootCommand : Command
    {
    }

    private class FileSecurity<T>
    {
        public void RemoveAccessRule(T rule)
        {
        }
    }

    private sealed class DerivedFileSecurity<T> : FileSecurity<T>
    {
    }

    private interface IQueueDefault
    {
        bool TryDequeue() => true;
    }

    private sealed class QueueWithDefault : IQueueDefault
    {
    }

    private sealed class AggregateFailingType : TypeDelegator
    {
        private readonly Type delegatedType;

        public AggregateFailingType(Type delegatingType)
            : base(delegatingType)
        {
            delegatedType = delegatingType;
        }

        public override Type GetGenericTypeDefinition() => delegatedType.GetGenericTypeDefinition();

        public override MethodInfo[] GetMethods(BindingFlags bindingAttr)
            => (bindingAttr & BindingFlags.DeclaredOnly) == 0
                ? throw new FileNotFoundException("Simulated missing metadata dependency.")
                : base.GetMethods(bindingAttr);
    }
}
