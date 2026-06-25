// <copyright file="Issue1132LetReferenceFieldWriteBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1132: <c>let</c> communicates immutability of the <em>binding</em>
/// (shallow / readonly-reference semantics). Writing a field or property of a
/// <em>reference-type</em> object held by a <c>let</c> local mutates the heap
/// object, not the binding, so it must be allowed; only the binding itself
/// (<c>b = other</c>) and member writes through a <em>value-type</em> <c>let</c>
/// local (which would mutate the value in the read-only slot) stay rejected
/// with <c>GS0127</c>.
/// </summary>
public class Issue1132LetReferenceFieldWriteBinderTests
{
    [Fact]
    public void LetClassLocal_FieldWrite_Allowed()
    {
        // Acceptance #1: `let b = Box{}; b.Value = 5` (class receiver).
        const string source = """
            package p
            class Box { var Value int32 = 0 }
            class C {
                func F() int32 {
                    let b = Box{ }
                    b.Value = 5
                    return b.Value
                }
            }
            """;

        Assert.DoesNotContain(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_PropertyWrite_Allowed()
    {
        // Acceptance #2: property write through a `let` class local.
        const string source = """
            package p
            class Box {
                var _v int32 = 0
                prop Value int32 {
                    get { return _v }
                    set { _v = value }
                }
            }
            class C {
                func F() int32 {
                    let b = Box{ }
                    b.Value = 5
                    return b.Value
                }
            }
            """;

        Assert.DoesNotContain(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_CompoundFieldWrite_Allowed()
    {
        // Acceptance #3: `let b = Counter{}; b.Value += 1` (class receiver).
        const string source = """
            package p
            class Counter { var Value int32 = 0 }
            class C {
                func F() int32 {
                    let b = Counter{ }
                    b.Value += 1
                    return b.Value
                }
            }
            """;

        Assert.DoesNotContain(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_IncrementFieldWrite_Allowed()
    {
        // Acceptance #3: `let b = Counter{}; b.Value++` (class receiver).
        const string source = """
            package p
            class Counter { var Value int32 = 0 }
            class C {
                func F() int32 {
                    let b = Counter{ }
                    b.Value++
                    return b.Value
                }
            }
            """;

        Assert.DoesNotContain(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_FieldWrite_Rejected()
    {
        // Acceptance #4: a value-type (struct) receiver stays rejected.
        const string source = """
            package p
            struct S { var Value int32 }
            class C {
                func F() int32 {
                    let s = S{ Value: 1 }
                    s.Value = 5
                    return s.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_PropertyWrite_Rejected()
    {
        // Acceptance #4: struct property write through a `let` struct local.
        const string source = """
            package p
            struct S {
                var _v int32
                prop Value int32 {
                    get { return _v }
                    set { _v = value }
                }
            }
            class C {
                func F() int32 {
                    let s = S{ }
                    s.Value = 5
                    return s.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_CompoundFieldWrite_Rejected()
    {
        // Acceptance #4: struct compound write through a `let` struct local.
        const string source = """
            package p
            struct S { var Value int32 }
            class C {
                func F() int32 {
                    let s = S{ Value: 1 }
                    s.Value += 1
                    return s.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_IncrementFieldWrite_Rejected()
    {
        // Acceptance #4: struct increment through a `let` struct local.
        const string source = """
            package p
            struct S { var Value int32 }
            class C {
                func F() int32 {
                    let s = S{ Value: 1 }
                    s.Value++
                    return s.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_Rebind_Rejected()
    {
        // Acceptance #5: direct rebinding of a `let` class local stays rejected.
        const string source = """
            package p
            class Box { var Value int32 = 0 }
            class C {
                func F() int32 {
                    let b = Box{ }
                    b = Box{ }
                    return b.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_Rebind_Rejected()
    {
        // Acceptance #5: direct rebinding of a `let` struct local stays rejected.
        const string source = """
            package p
            struct S { var Value int32 }
            class C {
                func F() int32 {
                    let s = S{ Value: 1 }
                    s = S{ Value: 2 }
                    return s.Value
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void VarClassLocal_FieldWrite_StillAllowed()
    {
        // Acceptance #7 (no regression): `var b` field writes are unaffected.
        const string source = """
            package p
            class Box { var Value int32 = 0 }
            class C {
                func F() int32 {
                    var b = Box{ }
                    b.Value = 5
                    return b.Value
                }
            }
            """;

        Assert.DoesNotContain(Bind(source), d => d.Id == "GS0127");
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
