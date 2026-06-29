// <copyright file="Issue1344ChannelReaderUserElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
/// Issue #1344: iterating <c>Channel[UserType].Reader.ReadAllAsync()</c> with
/// <c>await for</c> erased the user element type to <c>object</c>, so member
/// access on the loop variable failed <c>GS0158</c>. The <c>.Reader</c>
/// property surfaced an erased <c>ChannelReader[object]</c> whose
/// <c>ReadAllAsync()</c> yields <c>IAsyncEnumerable[object]</c>. The fix keeps
/// the symbolic <c>ChannelReader[UserType]</c> projection (sibling of
/// #1320/#1328). These binder tests mirror the issue repro; the user-element
/// case binds clean and the primitive-element control keeps working.
/// </summary>
public class Issue1344ChannelReaderUserElementTests
{
    [Fact]
    public void ReadAllAsync_UserElement_AwaitFor_MemberAccess_Binds()
    {
        // BUG: GS0158 — `messages` erased to object so `.NumEntries` not found.
        const string source = @"
package p
import System.Threading.Channels
import System.Threading.Tasks
class BufferEntry { prop NumEntries int32 { get; init; } }
class Reader {
    async func Consume(ch Channel[BufferEntry]) {
        await for messages in ch.Reader.ReadAllAsync() {
            let n = messages.NumEntries
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ReadAllAsync_PrimitiveElement_Control_Binds()
    {
        // Control: primitive element type was never affected.
        const string source = @"
package p
import System.Threading.Channels
import System.Threading.Tasks
class Reader {
    async func Consume(ch Channel[int32]) {
        await for n in ch.Reader.ReadAllAsync() {
            let m = n + 1
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Threading.Channels.Channel).Assembly.Location,
            typeof(System.Threading.Tasks.Task).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        var all = tree.Diagnostics
            .Concat(globalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper so the test cases can call <c>Assert.Empty</c> against a
    /// <see cref="ImmutableArray{T}"/> without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var diagnostic in this.diagnostics)
            {
                yield return diagnostic;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
