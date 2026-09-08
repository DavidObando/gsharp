// <copyright file="Issue4065MethodGroupValueDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4065: an unresolved method group used without a delegate target must
/// be rejected by binding rather than reaching emit as <c>GS9998</c>.
/// </summary>
public sealed class Issue4065MethodGroupValueDiagnosticTests
{
    public static IEnumerable<object[]> InvalidValueContexts()
    {
        yield return Case(
            "member-chain",
            """
            package P
            import System.Collections.Generic

            func Test() object {
                let values = List[int32]()
                return values.Add.ToString()
            }
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "assignment",
            """
            package P
            import System.Collections.Generic

            func Test() {
                let values = List[int32]()
                var value object = values.Add
            }
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "inference",
            """
            package P
            import System.Collections.Generic

            func Test() {
                let values = List[int32]()
                var value = values.Add
            }
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "top-level-inference",
            """
            package P
            import System.Collections.Generic

            let values = List[int32]()
            let value = values.Add
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "argument",
            """
            package P
            import System.Collections.Generic

            func Consume(value object) {}
            func Test() {
                let values = List[int32]()
                Consume(values.Add)
            }
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "user-argument",
            """
            package P

            func Read() int32 -> 1
            func Consume(value object) {}
            func Test() {
                Consume(Read)
            }
            """,
            "user method group",
            "Read");

        yield return Case(
            "interpolation",
            """
            package P
            import System
            import System.Collections.Generic

            func Test() {
                let values = List[int32]()
                Console.WriteLine("value=${values.Add}")
            }
            """,
            "imported instance method group",
            "Add");

        yield return Case(
            "return",
            """
            package P
            import System.Collections.Generic

            func Test() object {
                let values = List[int32]()
                return values.Add
            }
            """,
            "imported instance method group",
            "Add");

        yield return new object[]
        {
            "conditional",
            """
            package P
            import System.Collections.Generic

            func Test() {
                let values = List[int32]()
                var value = true ? values.Add : values.Add
            }
            """,
            "imported instance method group",
            new[] { "Add", "Add" },
        };

        yield return Case(
            "imported-static",
            """
            package P
            import System

            func Test() object -> Console.WriteLine.ToString()
            """,
            "imported static method group",
            "WriteLine");

        yield return Case(
            "user-group",
            """
            package P
            import System

            func Convert(value string) int32 -> value.Length
            func Convert(value int32) string -> value.ToString()
            func Test() string -> "value=${Convert}"
            """,
            "user method group",
            "Convert");

        yield return Case(
            "user-instance",
            """
            package P

            class Box {
                func Read() int32 -> 1
                func Read(value int32) int32 -> value
                func Test() object -> this.Read
            }
            """,
            "user instance method group",
            "Read");

        yield return Case(
            "user-instance-single",
            """
            package P

            class Box {
                func Read() int32 -> 1
                func Test() object -> this.Read
            }
            """,
            "user instance method group",
            "Read");

        yield return Case(
            "user-static",
            """
            package P

            class Box {
                shared {
                    func Read() int32 -> 1
                }

                func Test() object -> Box.Read
            }
            """,
            "user static method group",
            "Read");

        yield return Case(
            "user-extension",
            """
            package P

            func (value string) Measure() int32 -> value.Length
            func (value string) Measure(radix int32) int32 -> value.Length + radix
            func Test() object -> "abc".Measure
            """,
            "user extension method group",
            "Measure");

        yield return Case(
            "nullable-receiver-extension",
            """
            package P
            import System.Collections.Generic
            import System.Linq

            func Test() object {
                let values List[int32]? = List[int32]()
                return values.Count.ToString()
            }
            """,
            "imported extension method group",
            "Count");
    }

    [Theory]
    [MemberData(nameof(InvalidValueContexts))]
    public void MethodGroupWithoutDelegateTarget_ReportsGS0582AtName(
        string _,
        string source,
        string methodGroupKind,
        string[] expectedNames)
    {
        var diagnostics = Errors(source);

        Assert.Equal(expectedNames.Length, diagnostics.Length);
        foreach (var (diagnostic, expectedName) in diagnostics.Zip(expectedNames))
        {
            Assert.Equal("GS0582", diagnostic.Id);
            Assert.Equal(
                $"The {methodGroupKind} '{expectedName}' cannot be used as a value without a target delegate type. Invoke it with '(...)' or convert it to a delegate.",
                diagnostic.Message);
            Assert.Equal(expectedName, diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
        }
    }

    [Fact]
    public void IncompatibleDelegateTarget_StillReportsGS0218()
    {
        var diagnostic = Assert.Single(Errors(
            """
            package P
            import System
            import System.Collections.Generic

            func Test() {
                let values = List[int32]()
                let bad Action[string] = values.Add
            }
            """));
        Assert.Equal("GS0218", diagnostic.Id);
    }

    [Fact]
    public void InvalidDeclaredTarget_DoesNotCascadeGS0582()
    {
        var diagnostics = Errors(
            """
            package P
            import System

            func Test() {
                let value MissingType = Console.WriteLine
            }
            """);

        Assert.Single(diagnostics);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0582");
    }

    [Fact]
    public void CallsAndDelegateTargets_StillBind()
    {
        Assert.Empty(Errors(
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func Use(action Action[int32]) {
                action.Invoke(3)
            }

            func Pick(values List[int32]) Action[int32] {
                return values.Add
            }

            func Test() {
                let values = List[int32]()
                values.Add(1)
                Use(values.Add)
                let add Action[int32] = values.Add
                add.Invoke(4)
                let selected Action[int32] = true ? values.Add : values.Add
                selected.Invoke(5)

                let maybeValues List[int32]? = values
                let count Func[int32] = maybeValues.Count
                Console.WriteLine(maybeValues.Count())
                Console.WriteLine(count.Invoke())
                Pick(values).Invoke(6)

                let normalizer Func[string, string]? = nil
                let normalizeText = normalizer ?? Normalize
                Console.WriteLine(normalizeText.Invoke("ok"))
            }

            func Normalize(value string) string -> value
            """));
    }

    private static object[] Case(
        string name,
        string source,
        string methodGroupKind,
        params string[] expectedNames)
        => new object[] { name, source, methodGroupKind, expectedNames };

    private static Diagnostic[] Errors(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
    }
}
