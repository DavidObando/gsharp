// <copyright file="Issue1358ImportedPointerParameterBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1358: imported static methods with unmanaged-pointer parameters must
/// remain in the candidate set and participate in overload resolution.
/// </summary>
public class Issue1358ImportedPointerParameterBindingTests
{
    [Fact]
    public void ImportedGenericStaticMethod_WithTypedPointerParameter_Binds()
    {
        const string source = """
            package P
            import System.Runtime.Intrinsics

            class C {
                unsafe func G(p *uint8) {
                    let v = Vector256.Load(p)
                }
            }
            """;

        Assert.Empty(GetErrorDiagnostics(source));
    }

    [Fact]
    public void ImportedGenericStaticMethod_WithVoidPointerParameter_Binds()
    {
        const string source = """
            package P
            import System.Runtime.CompilerServices

            class C {
                unsafe func G(p *uint8) {
                    let v = Unsafe.Read[uint8](p)
                }
            }
            """;

        Assert.Empty(GetErrorDiagnostics(source));
    }

    private static DiagnosticCollection GetErrorDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var all = tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new DiagnosticCollection(all);
    }

    private readonly struct DiagnosticCollection : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public DiagnosticCollection(ImmutableArray<Diagnostic> diagnostics)
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
