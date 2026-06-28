// <copyright file="Issue1316AssignmentTargetTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1316: a simple-assignment statement <c>lhs = rhs</c> must propagate
/// the declared type of <c>lhs</c> (a property/field/local of type <c>T?</c>)
/// as the target/expected type when binding <c>rhs</c>. Without this, a
/// conditional/if-expression with a <c>nil</c> arm and a <c>T</c> arm binds
/// context-free, picks <c>T</c> from the non-nil arm, and rejects the
/// <c>nil</c> arm with <c>GS0155</c> — even though the identical RHS bound
/// through <c>let x T? = rhs</c> (which does receive the target type) compiles
/// cleanly. The target type must flow into the assignment RHS the same way.
/// </summary>
public class Issue1316AssignmentTargetTypeTests
{
    [Fact]
    public void PropertyAssignment_ConditionalWithNilArm_NoDiagnostics()
    {
        // Acceptance (a): the issue repro — `A = if c { nil } else { T(...) }`
        // where `A : AesCtr?` must bind clean (previously GS0155).
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                init(key []uint8) {
                    A = if key.Length == 0 { nil } else { AesCtr(key) }
                }
                prop A AesCtr? { get; init; }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void BareFieldAssignment_ConditionalWithNilArm_NoDiagnostics()
    {
        // Acceptance (b): bare field-name assignment variant.
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                var f AesCtr?
                init(key []uint8) {
                    f = if key.Length == 0 { nil } else { AesCtr(key) }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DottedFieldAssignment_ConditionalWithNilArm_NoDiagnostics()
    {
        // Acceptance (b): `this.f = ...` dotted field-write variant.
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                var f AesCtr?
                init(key []uint8) {
                    this.f = if key.Length == 0 { nil } else { AesCtr(key) }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void LocalAssignment_ConditionalWithNilArm_NoDiagnostics()
    {
        // Acceptance (b): local-variable assignment variant.
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                func F(key []uint8) {
                    var a AesCtr? = nil
                    a = if key.Length == 0 { nil } else { AesCtr(key) }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PropertyAssignment_IncompatibleValue_StillErrors()
    {
        // Acceptance (c): a genuinely-incompatible assignment (`A = 5` for
        // `A : AesCtr?`) must STILL report GS0155.
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                init(key []uint8) {
                    A = 5
                }
                prop A AesCtr? { get; init; }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void LetInitializer_ConditionalWithNilArm_StillBinds()
    {
        // Acceptance (d): the pre-existing `let x T? = if ... nil ...` control
        // must keep binding cleanly (the path the fix mirrors).
        const string source = """
            package p
            class AesCtr { init(k []uint8) {} }
            class C {
                init(key []uint8) {
                    let a AesCtr? = if key.Length == 0 { nil } else { AesCtr(key) }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
