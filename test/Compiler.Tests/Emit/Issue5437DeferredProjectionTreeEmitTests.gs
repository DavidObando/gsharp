// <copyright file="Issue5437DeferredProjectionTreeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.IO
import System.Text
import Xunit

class Issue5437DeferredProjectionTreeEmitTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ImportedProjectionTree_DefersCapturesAndUpdatesOnEveryInvocation(referenceAssembly bool, overrides bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ProjectionEffects5435.ref.dll")
        let contract = EmitContract(fixture, reference)
        let expression = if overrides {
            `Box[string]{...Source[string]("payload"), Tail: Read.Tail(), Value: Read.Override()}`
        } else {
            `Box[string]{...Source[string]("payload")}`
        }
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
import ProjectionEffects5435
Console.WriteLine("build")
let tree Expression[Func[Box[string]]] = () -> EXPRESSION
Read.Check(tree)
Console.WriteLine("built")
let invoke = tree.Compile()
Console.WriteLine("compiled")
for var i = 0; i < 2; i++ {
    Console.WriteLine("invoke")
    let value = invoke()
    Console.WriteLine(Read.Primary(value))
    Console.WriteLine(Read.Base(value))
    Console.WriteLine(value.GetType() == typeof(Box[string]))
    Console.WriteLine(value.Extra)
    Console.WriteLine(value.Tail)
}
`.Replace(
                "EXPRESSION",
                expression,
                StringComparison.Ordinal
            ), "DeferredProjection", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        let invocation = if overrides {
            "invoke\nsource\noverride\nconstructor\ntail\nset-tail\noverride\n0\nTrue\n9\n3\n"
        } else {
            "invoke\nsource\nget-value\nconstructor\nget-tail\nset-tail\npayload\n0\nTrue\n9\n2\n"
        }
        Assert.Equal(ConsoleBytes("build\nbuilt\ncompiled\n" + invocation + invocation), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedProjectionTree_PreservesCapturedCellsAndLambdaParameters(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ProjectionEffects5435.ref.dll")
        let contract = EmitContract(fixture, reference)
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
import ProjectionEffects5435
class Api {
    shared {
        public func Captured() Expression[Func[Box[string]]] {
            var text = "before"
            let tree Expression[Func[Box[string]]] = () -> Box[string]{...Source[string](text)}
            text = "after"
            return tree
        }
        public func Parameter() Expression[Func[string, Box[string]]] ->
            (text string) -> Box[string]{...Source[string](text)}
    }
}
Console.WriteLine("build")
let captured = Api.Captured()
let parameterized = Api.Parameter()
Read.Check(captured)
Read.Check(parameterized)
Console.WriteLine("built")
let first = captured.Compile()
let second = parameterized.Compile()
Console.WriteLine("compiled")
Read.Print(first())
Read.Print(first())
Read.Print(second("one"))
Read.Print(second("two"))
`, "ProjectionInputs", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        let effects = "source\nget-value\nconstructor\nget-tail\nset-tail\n"
        Assert.Equal(
            ConsoleBytes(
                "build\nbuilt\ncompiled\n" +
                    effects +
                    "after\n0\n9\n2\n" +
                    effects +
                    "after\n0\n9\n2\n" +
                    effects +
                    "one\n0\n9\n2\n" +
                    effects +
                    "two\n0\n9\n2\n"
            ),
            fixture.RunBytes(dll)
        )
    }

    private func EmitContract(fixture NativeSliceLanguageTests.Fixture, reference string) string {
        let contract = fixture.CompileCSharpWithReference(`#nullable enable
using System;
using System.Linq;
using System.Linq.Expressions;
namespace ProjectionEffects5435;
public record Base {
    public int Value;
}
public record Box<T> : Base {
    public Box(string Value, int Extra = 9) =>
        throw new InvalidOperationException("not primary");
    public Box(T Value, int Extra = 9) {
        Console.WriteLine("constructor");
        this.Value = Value;
        this.Extra = Extra;
    }
    public new T Value { get; init; }
    public int Extra { get; init; }
    private int tail;
    public int Tail {
        get => tail;
        set { Console.WriteLine("set-tail"); tail = value; }
    }
}
public sealed class Source<T> {
    private readonly T value;
    public Source(T value) {
        Console.WriteLine("source");
        this.value = value;
    }
    public T Value {
        get { Console.WriteLine("get-value"); return value; }
    }
    public int Tail {
        get { Console.WriteLine("get-tail"); return 2; }
    }
}
public static class Read {
    public static T Primary<T>(Box<T> box) => box.Value;
    public static int Base<T>(Box<T> box) => ((Base)box).Value;
    public static string Override() {
        Console.WriteLine("override");
        return "override";
    }
    public static int Tail() {
        Console.WriteLine("tail");
        return 3;
    }
    public static void Print(Box<string> box) {
        Console.WriteLine(Primary(box));
        Console.WriteLine(Base(box));
        Console.WriteLine(box.Extra);
        Console.WriteLine(box.Tail);
    }
    public static void Check(LambdaExpression tree) {
        if (tree.Body is not BlockExpression block || block.Variables.Count == 0)
            throw new InvalidOperationException("missing deferred capture");
        var check = new ConstructorCheck();
        check.Visit(tree);
        if (check.Count != 1)
            throw new InvalidOperationException("missing construction");
    }
    private sealed class ConstructorCheck : ExpressionVisitor {
        public int Count;
        protected override Expression VisitNew(NewExpression node) {
            if (node.Type == typeof(Box<string>)) {
                Count++;
                var primary = typeof(Box<>).GetConstructors().Single(
                    c => c.GetParameters()[0].ParameterType.IsGenericParameter);
                if (node.Constructor!.DeclaringType != typeof(Box<string>) ||
                    node.Constructor.MetadataToken != primary.MetadataToken ||
                    node.Arguments.Count != 2 ||
                    node.Arguments[1] is not ConstantExpression { Value: 9 })
                    throw new InvalidOperationException("wrong constructor");
            }
            return base.VisitNew(node);
        }
    }
}
`, "ProjectionEffects5435", reference)
        IlVerifier.Verify(contract)
        return contract
    }

    private func ConsoleBytes(value string)[]uint8 -> Encoding.UTF8.GetBytes(
        value.Replace("\n", Environment.NewLine, StringComparison.Ordinal)
    )
}
