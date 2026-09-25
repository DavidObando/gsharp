// <copyright file="ProtectedReceiverAccessBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4453: a derived class reaches a <c>protected</c> instance member
/// of a source base class only through a receiver of its own type or a
/// subtype (C# CS1540). A base- or sibling-typed receiver used to compile and
/// fail ILVerify (<c>FieldAccess</c>/<c>MethodAccess</c>); it is now GS0379 at
/// the member name. The rule covers every member kind and every access
/// shape, because it runs over the bound body rather than per binder path.
/// The reachable cells are compiled, verified and run in Compiler.Tests'
/// <c>ProtectedReceiverAccessEmitTests</c>.
/// </summary>
public sealed class ProtectedReceiverAccessBinderTests
{
    private const string Declarations = """
        import System

        open class Source {
            protected var f int32
            protected func M() int32 -> 1
            protected prop P int32 { get -> 2 }
            protected prop Q int32 { get; set; }
            protected event E EventHandler?
            shared {
                protected var sf int32
                protected func SM() int32 -> 5
            }
        }

        open class Derived : Source {
        }

        class MoreDerived : Derived {
        }

        class Sibling : Source {
        }

        """;

    /// <summary>
    /// Every member kind and access shape through a receiver typed as the
    /// declaring base class, and through a sibling subclass: one GS0379 at the
    /// member's name, as C# reports one CS1540.
    /// </summary>
    /// <param name="statement">The access, written against receiver <c>r</c>.</param>
    /// <param name="member">The member the diagnostic names and points at.</param>
    [Theory]
    [InlineData("let x = r.f", "f")]
    [InlineData("r.f = 1", "f")]
    [InlineData("r.f += 1", "f")]
    [InlineData("let x = r.M()", "M")]
    [InlineData("let g = r.M", "M")]
    [InlineData("let x = r.P", "P")]
    [InlineData("let x = r?.P", "P")]
    [InlineData("r.Q = 1", "Q")]
    [InlineData("r.Q += 1", "Q")]
    [InlineData("r.E += h", "E")]
    [InlineData("r.E -= h", "E")]
    [InlineData("let l = func() int32 { return r.f }", "f")]
    public void ThroughBaseOrSiblingReceiver_IsGS0379AtMember(string statement, string member)
    {
        foreach (var receiverType in new[] { "Source", "Sibling" })
        {
            var source = Declarations + $$"""
                class Accessor : Derived {
                    func Hook(r {{receiverType}}, h EventHandler) {
                        {{statement}}
                    }
                }
                """;

            AssertSingleGS0379At(source, statement, member);
        }
    }

    /// <summary>
    /// A type parameter whose class constraint is the base stands for the
    /// base: C# reports CS1540 for <c>x.f</c> where <c>X : Source</c>.
    /// </summary>
    [Fact]
    public void ThroughTypeParameterConstrainedToBase_IsGS0379()
    {
        const string statement = "x.f = 1";
        var source = Declarations + $$"""
            class Accessor : Derived {
                func Hook[X Source](x X) {
                    {{statement}}
                }
            }
            """;

        AssertSingleGS0379At(source, statement, "f");
    }

    /// <summary>
    /// A field initializer is code of its class too: <c>Source().f</c> in a
    /// derived class's initializer is CS1540 in C#.
    /// </summary>
    [Fact]
    public void InFieldInitializer_ThroughBaseReceiver_IsGS0379()
    {
        const string statement = "var g int32 = Source().f";
        var source = Declarations + $$"""
            class Accessor : Derived {
                {{statement}}
            }
            """;

        AssertSingleGS0379At(source, statement, "f");
    }

    /// <summary>
    /// A <c>shared</c> init block of a derived class follows the same rule.
    /// </summary>
    [Fact]
    public void InStaticInitializer_ThroughBaseReceiver_IsGS0379()
    {
        const string statement = "Source().M()";
        var source = Declarations + $$"""
            class Accessor : Derived {
                shared {
                    init {
                        {{statement}}
                    }
                }
            }
            """;

        AssertSingleGS0379At(source, statement, "M");
    }

    /// <summary>
    /// An unrelated class already fails the class-level check; the receiver
    /// rule must not report the same access a second time.
    /// </summary>
    [Fact]
    public void FromUnrelatedClass_ReportsOnce()
    {
        const string statement = "r.f = 1";
        var source = Declarations + $$"""
            class Other {
                func Hook(r Sibling) {
                    {{statement}}
                }
            }
            """;

        AssertSingleGS0379At(source, statement, "f");
    }

    /// <summary>
    /// The cells C# allows bind without diagnostics: <c>this</c>,
    /// <c>base</c>, bare names, receivers of the accessing class and of its
    /// subclasses (including inside a lambda, a method group and a
    /// null-conditional access), a type parameter constrained to the
    /// accessing class, any construction of a generic accessing class, static
    /// members through the declaring type, and the declaring class itself
    /// through any receiver.
    /// </summary>
    [Fact]
    public void ReachableCells_Bind()
    {
        var source = Declarations + """
            open class Accessor : Derived {
                func Hook(a Accessor, m MoreAccessor, h EventHandler) int32 {
                    this.f = 1
                    a.f = 2
                    m.f += 3
                    a.Q = 4
                    m.Q += 5
                    a.E += h
                    m.E -= h
                    f = 6
                    E += h
                    let l = func() int32 { return a.f + this.M() }
                    let g = m.M
                    let n = a?.P
                    let s = Source.sf + Source.SM() + Derived.SM()
                    return base.f + base.M() + a.M() + m.P + l() + g() + s + (n ?? 0)
                }
                func Constrained[X Accessor](x X) int32 -> x.f + x.M()
            }
            class MoreAccessor : Accessor {
            }
            open class G[T] : Source {
                func Hook(o G[int32], p G[T]) int32 -> o.f + p.M() + this.P
            }
            open class Base2 {
                protected var v int32
                func Any(o Base2, d Sub2) int32 -> o.v + d.v
            }
            class Sub2 : Base2 {
            }
            """;

        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        Assert.True(errors.Length == 0, string.Join(Environment.NewLine, errors.Select(e => $"{e.Id} {e.Location.StartLine + 1}: {e.Message}")));
    }

    private static void AssertSingleGS0379At(string source, string statement, string member)
    {
        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        var error = Assert.Single(errors);
        Assert.Equal("GS0379", error.Id);
        Assert.Contains($"'Source.{member}'", error.Message, StringComparison.Ordinal);

        // The diagnostic points at the member's name in the statement.
        var text = Assert.IsType<GSharp.Core.CodeAnalysis.Text.SourceText>(error.Location.Text);
        Assert.Equal(member, text.ToString(error.Location.Span));
        var line = text.Lines[error.Location.StartLine].ToString();
        var statementColumn = line.IndexOf(statement, StringComparison.Ordinal);
        Assert.True(statementColumn >= 0, $"GS0379 is on '{line}', not on the statement '{statement}'");
        var memberColumn = statement.IndexOf(member, statement.IndexOf('.', StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Equal(statementColumn + memberColumn, error.Location.StartCharacter);
    }
}
