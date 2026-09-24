// <copyright file="InheritedProtectedStaticMemberBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0192 follow-on 2: a class deriving from an imported base calls an
/// inherited <c>protected</c> static member, as the real
/// <c>[GeneratedRegex]</c> output does with
/// <c>Regex.ValidateMatchTimeout(timeout)</c> (a <c>protected internal
/// static</c> method of <c>System.Text.RegularExpressions.Regex</c>).
/// <para>
/// Imported static lookup admitted only public and friend-internal members,
/// so the qualified spelling reported GS0159. The unqualified spelling
/// reported GS0130 for any inherited static method, public or protected,
/// from an imported or a source base: the implicit-<c>this</c> call path
/// only searched the enclosing type's own static methods and the base's
/// instance methods.
/// </para>
/// </summary>
public class InheritedProtectedStaticMemberBinderTests
{
    [Fact]
    public void ImportedProtectedStaticMethod_QualifiedAndUnqualified_BindAndRun()
    {
        const string source = """
            import System
            import System.Text.RegularExpressions

            class MyRegex : Regex {
                init(timeout TimeSpan) {
                    Regex.ValidateMatchTimeout(timeout)
                    ValidateMatchTimeout(timeout)
                    MyRegex.ValidateMatchTimeout(timeout)
                }

                func Check(timeout TimeSpan) string {
                    try {
                        ValidateMatchTimeout(timeout)
                        return "valid"
                    } catch (e ArgumentOutOfRangeException) {
                        return "rejected"
                    }
                }

                shared {
                    func CheckStatic(timeout TimeSpan) string {
                        try {
                            ValidateMatchTimeout(timeout)
                            return "valid"
                        } catch (e ArgumentOutOfRangeException) {
                            return "rejected"
                        }
                    }
                }
            }

            let r = MyRegex(TimeSpan.FromSeconds(1.0))
            Console.WriteLine(r.Check(TimeSpan.FromSeconds(-5.0)))
            Console.WriteLine(MyRegex.CheckStatic(Regex.InfiniteMatchTimeout))
            """;

        AssertRuns(source, "rejected", "valid");
    }

    [Fact]
    public void ImportedPublicStaticMethod_Unqualified_BindsAndRuns()
    {
        const string source = """
            import System
            import System.Text.RegularExpressions

            class MyRegex : Regex {
                func Quote(text string) string -> Escape(text)
                shared {
                    func QuoteStatic(text string) string -> Escape(text)
                }
            }

            Console.WriteLine(MyRegex().Quote("a.b"))
            Console.WriteLine(MyRegex.QuoteStatic("c*d"))
            """;

        AssertRuns(source, "a\\.b", "c\\*d");
    }

    [Fact]
    public void ImportedProtectedStaticMethod_FromUnrelatedClass_IsRejected()
    {
        const string source = """
            import System
            import System.Text.RegularExpressions

            class NotARegex {
                func Go() {
                    Regex.ValidateMatchTimeout(TimeSpan.FromSeconds(1.0))
                }
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void SourceBaseStaticMethods_Unqualified_BindAndRun()
    {
        const string source = """
            import System

            open class Base {
                shared {
                    protected func Guarded() int32 -> 7
                    func Open() int32 -> 30
                    protected var count int32 = 3
                    protected prop Scale int32 { get; set; }
                }
            }

            class Derived : Base {
                func Go() int32 {
                    Base.count += 1
                    Base.count++
                    Base.Scale = 2
                    Base.Scale *= 5
                    return Guarded() + Open() + Base.Guarded() + Derived.Guarded() + Base.count + Base.Scale
                }

                shared {
                    func GoStatic() int32 -> Guarded() + Open()
                }
            }

            Console.WriteLine(Derived().Go())
            Console.WriteLine(Derived.GoStatic())
            """;

        AssertRuns(source, "66", "37");
    }

    [Fact]
    public void SourceBaseProtectedStaticMethod_FromUnrelatedClass_IsRejected()
    {
        const string source = """
            open class Base {
                shared { protected func Guarded() int32 -> 7 }
            }

            class Other {
                func Go() int32 -> Base.Guarded()
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void UnqualifiedCall_WithNoInheritedStatic_StillReportsGS0130()
    {
        const string source = """
            import System.Text.RegularExpressions

            class MyRegex : Regex {
                func Go() {
                    NoSuchStaticMethod()
                }
            }
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0130");
    }

    [Fact]
    public void InheritedStatic_DoesNotOutrankApplicableInstanceMethod()
    {
        // The inherited static is a last resort: a call that already bound to
        // the derived class's own instance method keeps binding to it, even
        // though the inherited `M(int32)` is a better match for `5`.
        const string source = """
            import System

            open class Base {
                shared {
                    func M(x int32) string -> "Base.M(int32)"
                }
            }

            class Derived : Base {
                func M(x object) string -> "Derived.M(object)"
                func Go() string -> M(5)
            }

            Console.WriteLine(Derived().Go())
            """;

        AssertRuns(source, "Derived.M(object)");
    }

    [Fact]
    public void InheritedStatic_DoesNotOutrankEnclosingTypeStatic()
    {
        // A nested class sees its enclosing type's statics unqualified. That
        // lookup came first before inherited statics were in scope, and it
        // still does: neither the source base's `H` nor Regex's `Escape`
        // takes over.
        const string source = """
            import System
            import System.Text.RegularExpressions

            open class Base {
                shared {
                    func H() string -> "Base.H"
                }
            }

            class Outer {
                shared {
                    func H() string -> "Outer.H"
                    func Escape(s string) string -> "Outer.Escape"
                }

                class Inner : Base {
                    func Go() string -> H()
                }

                class InnerRegex : Regex {
                    func Go() string -> Escape("a.b")
                    shared {
                        func GoStatic() string -> Escape("a.b")
                    }
                }
            }

            Console.WriteLine(Outer.Inner().Go())
            Console.WriteLine(Outer.InnerRegex().Go())
            Console.WriteLine(Outer.InnerRegex.GoStatic())
            """;

        AssertRuns(source, "Outer.H", "Outer.Escape", "Outer.Escape");
    }

    [Fact]
    public void RegexSubclass_InheritedInstanceAndStaticMembers_Unqualified()
    {
        const string source = """
            import System
            import System.Text.RegularExpressions

            class Digits : Regex {
                init() : base("[0-9]+") {
                    ValidateMatchTimeout(Regex.InfiniteMatchTimeout)
                }

                func Go() string {
                    let m = Match("ab12c")
                    return "${IsMatch("x9")} ${m.Value} ${Escape("1.2")}"
                }
            }

            Console.WriteLine(Digits().Go())
            """;

        AssertRuns(source, "True 12 1\\.2");
    }

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(
            string.Concat(expectedLines.Select(line => line + Environment.NewLine)),
            result.Output);
    }
}
