package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions
import Xunit
import Xunit.Abstractions

/// Issue #5536: a function value or method group keeps its delegate. It converts to a function or delegate target
/// only when each parameter and the result keep their reference (natural `Func`/`Action` variance, ADR-0108).
/// A function literal still converts its result value, because it binds its body to the target.
class Issue5536FunctionValueConversionDriverTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func NumericResult_OfFunctionValue_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
func C(x () -> int32) () -> int64 -> x
func Main() {}
`, `using System;
class Program {
    static Func<long> C(Func<int> x) => x;
    static void Main() {}
}
`, "CS0029", line: 2, column: 38, length: 1)
    }

    @Fact
    func ChannelReaderResult_OfFunctionValue_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System.Threading.Channels
func A(x () -> Channel[int32]) () -> ChannelReader[int32] -> x
func Main() {}
`, `using System;
using System.Threading.Channels;
class Program {
    static Func<ChannelReader<int>> A(Func<Channel<int>> x) => x;
    static void Main() {}
}
`, "CS0029", line: 2, column: 62, length: 1)
    }

    @Fact
    func NumericResult_ToSourceNamedDelegate_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
delegate D64() int64;
func N(x () -> int32) D64 -> x
func Main() {}
`, `using System;
delegate long D64();
class Program {
    static D64 N(Func<int> x) => x;
    static void Main() {}
}
`, "CS0029", line: 3, column: 30, length: 1)
    }

    @Fact
    func NumericResult_ToImportedDelegates_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import FunctionControl
func W(x () -> int32) Wide -> x
func Main() {}
`, `using System;
using FunctionControl;
class Program {
    static Wide W(Func<int> x) => x;
    static void Main() {}
}
`, "CS0029", line: 2, column: 31, length: 1)
        Reject(fixture, `import System
func F(x () -> int32) Func[int64] -> x
func Main() {}
`, `using System;
class Program {
    static Func<long> F(Func<int> x) => x;
    static void Main() {}
}
`, "CS0029", line: 2, column: 38, length: 1)
    }

    @Fact
    func NumericResult_OfMethodGroup_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
func G() int32 { return 7 }
func M() () -> int64 -> G
func Main() {}
`, `using System;
class Program {
    static int G() => 7;
    static Func<long> M() => G;
    static void Main() {}
}
`, "CS0407", line: 3, column: 25, length: 1)
    }

    @Fact
    func NumericResult_OfFunctionValueArgument_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
func Take(f () -> int64) int64 -> f()
func Main() {
    let x () -> int32 = () -> 1
    Take(x)
}
`, `using System;
class Program {
    static long Take(Func<long> f) => f();
    static void Main() {
        Func<int> x = () => 1;
        Take(x);
    }
}
`, "CS1503", line: 5, column: 10, length: 1, diagnostic: "GS0154")
    }

    @Fact
    func OverloadResolution_SkipsFunctionValueThatNeedsAConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
func M(f () -> int64) { Console.Write("F") }
func M(o object) { Console.Write("O") }
func Main() {
    let x () -> int32 = () -> 1
    M(x)
    M(() -> 1)
}
`, `using System;
class Program {
    static void M(Func<long> f) { Console.Write("F"); }
    static void M(object o) { Console.Write("O"); }
    static void Main() {
        Func<int> x = () => 1;
        M(x);
        M(() => 1);
    }
}
`, "OF")
    }

    @Fact
    func ChannelReaderResult_OfMethodGroup_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
import System.Threading.Channels
func Make() Channel[int32] { return Channel.CreateUnbounded[int32]() }
func Get() () -> ChannelReader[int32] -> Make
func Main() {}
`, `using System;
using System.Threading.Channels;
class Program {
    static Channel<int> Make() => Channel.CreateUnbounded<int>();
    static Func<ChannelReader<int>> Get() => Make;
    static void Main() {}
}
`, "CS0407", line: 4, column: 42, length: 4)
    }

    @Fact
    func NumericResult_ForwardedToOpenGenericParameter_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
func Take[T](f (T) -> int64) {}
func Forward[T](f (T) -> int32) { Take[T](f) }
func Main() { Forward[string]((s string) -> s.Length) }
`, `using System;
class Program {
    static void Take<T>(Func<T, long> f) {}
    static void Forward<T>(Func<T, int> f) { Take<T>(f); }
    static void Main() { Forward<string>(s => s.Length); }
}
`, "CS1503", line: 3, column: 43, length: 1, diagnostic: "GS0154")
    }

    @Fact
    func ImportedOverloadResolution_SkipsFunctionValueThatNeedsAConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    let f () -> int32 = () -> 1
    Console.Write(Calls.M(f, 1))
    Console.Write(Calls.M(() -> 1, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Func<int> f = () => 1;
        Console.Write(Calls.M(f, 1));
        Console.Write(Calls.M(() => 1, 1));
    }
}
`, "OF")
    }

    @Fact
    func ImportedInParameter_SkipsFunctionValueThatNeedsAConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    let f () -> int32 = () -> 1
    let g () -> int64 = () -> 2
    Console.Write(Calls.In(f, 1))
    Console.Write(Calls.In(g, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Func<int> f = () => 1;
        Func<long> g = () => 2;
        Console.Write(Calls.In(f, 1));
        Console.Write(Calls.In(g, 1));
    }
}
`, "OF")
    }

    /// Issue #5543: a function literal is a plain value, so it binds to the pointee of an imported `in` or
    /// `ref readonly` delegate parameter. That makes the delegate overload better than the `object` overload,
    /// as in C#.
    @Fact
    func FunctionLiteral_AtImportedInDelegateParameter_SelectsTheDelegate() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.In(() -> 1, 1))
    Console.Write(Calls.In(() -> { return 1 }, 1))
    Console.Write(Calls.RR(() -> 1, 1))
    Console.Write(Calls.P((y) -> y + 1, 1))
    Console.Write(Calls.PG((y) -> y + 1, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.In(() => 1, 1));
        Console.Write(Calls.In(() => { return 1; }, 1));
        Console.Write(Calls.RR(() => 1, 1));
        Console.Write(Calls.P(y => y + 1, 1));
        Console.Write(Calls.PG(y => y + 1, 1));
    }
}
`, "FFFF3F2")
    }

    /// Issue #5543: imported constructors, instance methods and reduced extension calls use the same `in`
    /// pointee target for a function literal.
    @Fact
    func FunctionLiteral_AtImportedInDelegateParameter_OfConstructorsAndInstanceCalls() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(InCtor(() -> 1, 1).Kind)
    Console.Write(InReceiver().M(() -> 1, 1))
    Console.Write(InReceiver().X(() -> 1, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(new InCtor(() => 1, 1).Kind);
        Console.Write(new InReceiver().M(() => 1, 1));
        Console.Write(new InReceiver().X(() => 1, 1));
    }
}
`, "FFF")
    }

    /// Issue #5543: symbolic target recovery reads the pointee of an `in` delegate slot too. A source type
    /// argument therefore reaches an explicit or inferred lambda parameter for generic receivers, generic
    /// methods, reduced extensions, static members and constructors.
    @Fact
    func FunctionLiteral_AtImportedInDelegateParameter_KeepsSourceTypeArguments() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import System.Collections.Generic
import FunctionControl
class Pt {
    var X int32 = 3
}
func Main() {
    let p = Pt()
    Console.Write(InBox[Pt]().M(p, (q Pt) -> q.X))
    Console.Write(InBox[Pt]().M(p, (q) -> q.X))
    Console.Write(InHolder[Pt](p, (q Pt) -> q.X).Kind)
    Console.Write(InHolder[Pt](p, (q) -> q.X).Kind)
    Console.Write(InStatic[Pt].S(p, (q Pt) -> q.X))
    Console.Write(InGeneric.Of(p, (q) -> q.X))
    Console.Write(List[Pt]{p}.Each((q) -> q.X))
}
`, `using System;
using System.Collections.Generic;
using FunctionControl;
class Pt {
    public int X = 3;
}
class Program {
    static void Main() {
        var p = new Pt();
        Console.Write(new InBox<Pt>().M(p, (Pt q) => q.X));
        Console.Write(new InBox<Pt>().M(p, q => q.X));
        Console.Write(new InHolder<Pt>(p, (Pt q) => q.X).Kind);
        Console.Write(new InHolder<Pt>(p, q => q.X).Kind);
        Console.Write(InStatic<Pt>.S(p, (Pt q) => q.X));
        Console.Write(InGeneric.Of(p, q => q.X));
        Console.Write(new List<Pt> { p }.Each(q => q.X));
    }
}
`, "B3B3H3H3S3G3E3")
    }

    /// Issue #5543 control: an expression-bodied literal whose result does not convert to the `in` delegate
    /// keeps its natural type, so the `object` overload applies, as for a by-value slot.
    @Fact
    func InDelegateParameter_IncompatibleExpressionLiteral_SelectsObject() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.In(() -> "s", 1))
    Console.Write(Calls.M(() -> "s", 1))
    Console.Write(InCtor(() -> "s", 1).Kind)
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.In(() => "s", 1));
        Console.Write(Calls.M(() => "s", 1));
        Console.Write(new InCtor(() => "s", 1).Kind);
    }
}
`, "OOO")
    }

    /// Issue #5569: a block-bodied literal is bound against a delegate target speculatively when another candidate
    /// takes its natural type. A literal whose `return` value does not convert makes the delegate candidates
    /// inapplicable, so the `object` overload applies, as in C#. This holds for by-value and `in` slots, methods,
    /// constructors, reduced extensions and generic receivers. A literal that converts still selects the delegate.
    @Fact
    func BlockLiteral_ThatDoesNotConvertToTheDelegate_SelectsObject() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
class Pt {
    var X int32 = 3
}
func Main() {
    Console.Write(Calls.In(() -> { return "s" }, 1))
    Console.Write(Calls.M(() -> { return "s" }, 1))
    Console.Write(InCtor(() -> { return "s" }, 1).Kind)
    Console.Write(C(() -> { return "s" }, 1).Kind)
    Console.Write(InReceiver().X(() -> { return "s" }, 1))
    Console.Write(LitBox[Pt]().M((p Pt) -> { return "s" }))
    Console.Write(Calls.In(() -> { return 1 }, 1))
    Console.Write(InCtor(() -> { return 1 }, 1).Kind)
    Console.Write(LitBox[Pt]().M((p Pt) -> { return p.X }))
}
`, `using System;
using FunctionControl;
class Pt {
    public int X = 3;
}
class Program {
    static void Main() {
        Console.Write(Calls.In(() => { return "s"; }, 1));
        Console.Write(Calls.M(() => { return "s"; }, 1));
        Console.Write(new InCtor(() => { return "s"; }, 1).Kind);
        Console.Write(new C(() => { return "s"; }, 1).Kind);
        Console.Write(new InReceiver().X(() => { return "s"; }, 1));
        Console.Write(new LitBox<Pt>().M((Pt p) => { return "s"; }));
        Console.Write(Calls.In(() => { return 1; }, 1));
        Console.Write(new InCtor(() => { return 1; }, 1).Kind);
        Console.Write(new LitBox<Pt>().M((Pt p) => { return p.X; }));
    }
}
`, "OOOOOOFFF")
    }

    /// Issue #5569: each speculative literal binds its body once, and a target-typed return value at most twice,
    /// so nested literals cost linear work. Before,
    /// a literal whose `return` value did not convert bound its body again with its natural type, so each
    /// nesting level doubled the work of the levels inside it. At depth 24 that compile does not finish within the
    /// 30-second driver bound; now it takes the same time as depth 1. Roslyn itself binds such nesting
    /// exponentially (CS9236), so its oracle uses depth 2 of the same shape, which gives the same output because
    /// no literal runs.
    @Fact
    func NestedBlockLiterals_ThatSelectObject_BindInLinearWork() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        let shapes = []string{"Calls.M(|, 1)", "Calls.In(|, 1)", "C(|, 1).Kind", "InCtor(|, 1).Kind"}
        let source = StringBuilder("import System\nimport FunctionControl\nfunc Main() {\n    let flag = true\n")
        let oracle = StringBuilder(
            "using System;\nusing FunctionControl;\nclass Program {\n    static void Main() {\n        var flag = true;\n"
        )
        // The second form returns a target-typed conditional, whose value also binds again with its natural type.
        let returns = []string{"\"s\"", "true ? \"s\" : \"t\""}
        for returned in returns {
            for shape in shapes {
                source
                    .Append("    Console.Write(")
                    .Append(NestBlockLiterals(shape, 24, "() -> { ", "return " + returned + " }"))
                    .Append(")\n")
                oracle
                    .Append("        Console.Write(")
                    .Append(NestBlockLiterals(OracleShape(shape), 2, "() => { ", "return " + returned + "; }"))
                    .Append(");\n")
            }
        }
        // The third form returns a block that returns the next block from a branch (review of PR #5564). Each
        // nested return binds in the pass of the value that contains it.
        for shape in shapes {
            source
                .Append("    Console.Write(")
                .Append(shape.Replace("|", "() -> { return " + NestReturnBlocks(24) + " }"))
                .Append(")\n")
            oracle
                .Append("        Console.Write(")
                .Append(
                OracleShape(shape).Replace(
                    "|",
                    "() => { if (flag) { if (flag) { return \"s\"; } return \"s\"; } return \"s\"; }"
                )
            )
                .Append(");\n")
        }
        source.Append("}\n")
        oracle.Append("    }\n}\n")
        Check(fixture, source.ToString(), oracle.ToString(), "OOOOOOOOOOOO")
    }

    /// Issue #5569 control (review of PR #5564): a literal whose parameter count no candidate's delegate accepts
    /// stops at the outermost level with one diagnostic, also when it is nested. The target bind does not run
    /// again after the natural bind, so 24 levels finish within the driver bound. Roslyn also reports one error
    /// at the outermost literal; its oracle uses depth 2 because Roslyn binds such nesting exponentially.
    @Fact
    func NestedLiterals_ThatNoCandidateAccepts_ReportOnce() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        let literal = NestRejectedLiterals(24, "(x int32)", "->")
        Reject(
            fixture,
            "import System\nimport FunctionControl\nfunc Main() {\n    Console.Write(Calls.N(" + literal + ", 1))\n}\n",
            "using System;\nusing FunctionControl;\nclass Program {\n    static void Main() {\n        Console.Write(Calls.N(" +
                NestRejectedLiterals(2, "(int x)", "=>") +
                ", 1));\n    }\n}\n",
            "CS1593",
            line: 4,
            column: 27,
            length: literal.Length,
            diagnostic: "GS0144"
        )
    }

    /// Issue #5569 (review of PR #5564): a return value that binds again with its natural type starts from the
    /// binder state before the value. A narrowing that the target pass removed is back, and a label that the
    /// target pass declared is not declared twice.
    @Fact
    func RetriedReturnValue_StartsFromTheStateBeforeTheValue() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        let shapes = []string{"Calls.M(|, 1)", "Calls.In(|, 1)", "C(|, 1).Kind", "InCtor(|, 1).Kind"}
        let narrowing = "() -> {\n        var x string? = \"a\"\n        if x != nil {\n            return {\n                let n = x.Length\n                x = nil\n                \"s\"\n            }\n        }\n        return \"t\"\n    }"
        let label = "() -> {\n        return {\n            L: Console.Write(\"\")\n            \"s\"\n        }\n    }"
        let oracleNarrowing = "() => { string? x = \"a\"; if (x != null) { var n = x.Length; x = null; return \"s\"; } return \"t\"; }"
        let oracleLabel = "() => { L: Console.Write(\"\"); return \"s\"; }"
        let source = StringBuilder("import System\nimport FunctionControl\nfunc Main() {\n")
        let oracle = StringBuilder("using System;\nusing FunctionControl;\nclass Program {\n    static void Main() {\n")
        for shape in shapes {
            source.Append("    Console.Write(").Append(shape.Replace("|", narrowing)).Append(")\n")
            source.Append("    Console.Write(").Append(shape.Replace("|", label)).Append(")\n")
            oracle
                .Append("        Console.Write(")
                .Append(OracleShape(shape).Replace("|", oracleNarrowing))
                .Append(");\n")
            oracle.Append("        Console.Write(").Append(OracleShape(shape).Replace("|", oracleLabel)).Append(");\n")
        }
        source.Append("}\n")
        oracle.Append("    }\n}\n")
        Check(fixture, source.ToString(), oracle.ToString(), "OOOOOOOO")
    }

    /// Issue #5569: a target-typed return value (conditional, `switch`, `if` or block) that does not convert to
    /// the delegate's result binds again with its natural type, so the `object` overload applies, as in C#. The
    /// C# oracle writes the `if` form as a conditional and the block form as a local. Values that convert still
    /// select the delegate.
    @Fact
    func TargetTypedReturnValue_ThatDoesNotConvert_SelectsObject() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    let k = 1
    Console.Write(Calls.M(() -> { return true ? "s" : "t" }, 1))
    Console.Write(Calls.In(() -> { return true ? "s" : "t" }, 1))
    Console.Write(C(() -> { return true ? "s" : "t" }, 1).Kind)
    Console.Write(InCtor(() -> { return true ? "s" : "t" }, 1).Kind)
    Console.Write(Calls.M(() -> { return switch k { case 1: "a" default: "b" } }, 1))
    Console.Write(Calls.In(() -> { return switch k { case 1: "a" default: "b" } }, 1))
    Console.Write(C(() -> { return switch k { case 1: "a" default: "b" } }, 1).Kind)
    Console.Write(InCtor(() -> { return switch k { case 1: "a" default: "b" } }, 1).Kind)
    Console.Write(Calls.M(() -> { return if true { "a" } else { "b" } }, 1))
    Console.Write(Calls.In(() -> { return if true { "a" } else { "b" } }, 1))
    Console.Write(C(() -> { return if true { "a" } else { "b" } }, 1).Kind)
    Console.Write(InCtor(() -> { return if true { "a" } else { "b" } }, 1).Kind)
    Console.Write(Calls.M(() -> { return {
        let q = "s"
        q
    } }, 1))
    Console.Write(Calls.In(() -> { return {
        let q = "s"
        q
    } }, 1))
    Console.Write(C(() -> { return {
        let q = "s"
        q
    } }, 1).Kind)
    Console.Write(InCtor(() -> { return {
        let q = "s"
        q
    } }, 1).Kind)
    Console.Write(Calls.M(() -> { return true ? 1 : 2 }, 1))
    Console.Write(Calls.In(() -> { return switch k { case 1: 1 default: 2 } }, 1))
    Console.Write(C(() -> { return if true { 1 } else { 2 } }, 1).Kind)
    Console.Write(InCtor(() -> { return {
        let q = 1
        q
    } }, 1).Kind)
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        var k = 1;
        Console.Write(Calls.M(() => { return true ? "s" : "t"; }, 1));
        Console.Write(Calls.In(() => { return true ? "s" : "t"; }, 1));
        Console.Write(new C(() => { return true ? "s" : "t"; }, 1).Kind);
        Console.Write(new InCtor(() => { return true ? "s" : "t"; }, 1).Kind);
        Console.Write(Calls.M(() => { return k switch { 1 => "a", _ => "b" }; }, 1));
        Console.Write(Calls.In(() => { return k switch { 1 => "a", _ => "b" }; }, 1));
        Console.Write(new C(() => { return k switch { 1 => "a", _ => "b" }; }, 1).Kind);
        Console.Write(new InCtor(() => { return k switch { 1 => "a", _ => "b" }; }, 1).Kind);
        Console.Write(Calls.M(() => { return true ? "a" : "b"; }, 1));
        Console.Write(Calls.In(() => { return true ? "a" : "b"; }, 1));
        Console.Write(new C(() => { return true ? "a" : "b"; }, 1).Kind);
        Console.Write(new InCtor(() => { return true ? "a" : "b"; }, 1).Kind);
        Console.Write(Calls.M(() => { var q = "s"; return q; }, 1));
        Console.Write(Calls.In(() => { var q = "s"; return q; }, 1));
        Console.Write(new C(() => { var q = "s"; return q; }, 1).Kind);
        Console.Write(new InCtor(() => { var q = "s"; return q; }, 1).Kind);
        Console.Write(Calls.M(() => { return true ? 1 : 2; }, 1));
        Console.Write(Calls.In(() => { return k switch { 1 => 1, _ => 2 }; }, 1));
        Console.Write(new C(() => { return true ? 1 : 2; }, 1).Kind);
        Console.Write(new InCtor(() => { var q = 1; return q; }, 1).Kind);
    }
}
`, "OOOOOOOOOOOOOOOOFFFF")
    }

    /// Issue #5569: an explicit parameter type or a parameter count that the delegate does not accept makes the
    /// delegate candidates inapplicable, so the `object` overload applies, as in C#. The target bind stops
    /// before the body, so the natural bind is the only body bind.
    @Fact
    func ExplicitlyTypedLiteral_ThatTheDelegateDoesNotAccept_SelectsObject() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.PV((x int32) -> { return x }, 1))
    Console.Write(Calls.P((x int32) -> { return x }, 1))
    Console.Write(PCtor((x int32) -> { return x }, 1).Kind)
    Console.Write(PInCtor((x int32) -> { return x }, 1).Kind)
    Console.Write(Calls.PV((x int32, y int32) -> { return x }, 1))
    Console.Write(Calls.PV((x int64) -> { return x }, 1))
    Console.Write(Calls.P((x int64) -> { return x }, 1))
    Console.Write(PCtor((x int64) -> { return x }, 1).Kind)
    Console.Write(PInCtor((x int64) -> { return x }, 1).Kind)
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.PV((int x) => { return x; }, 1));
        Console.Write(Calls.P((int x) => { return x; }, 1));
        Console.Write(new PCtor((int x) => { return x; }, 1).Kind);
        Console.Write(new PInCtor((int x) => { return x; }, 1).Kind);
        Console.Write(Calls.PV((int x, int y) => { return x; }, 1));
        Console.Write(Calls.PV((long x) => { return x; }, 1));
        Console.Write(Calls.P((long x) => { return x; }, 1));
        Console.Write(new PCtor((long x) => { return x; }, 1).Kind);
        Console.Write(new PInCtor((long x) => { return x; }, 1).Kind);
    }
}
`, "OOOOOF2F2F2F2")
    }

    /// Issue #5569: a literal that keeps its natural type keeps its written parameter types, so the `object`
    /// overload receives a `Func<long, string>` that it can call, as in C#.
    @Fact
    func NaturalLiteral_KeepsItsWrittenParameterTypes() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.Sig((x int64) -> { return "s" }, 1))
    Console.Write(Calls.SigIn((x int64) -> { return "s" }, 1))
    Console.Write(SigCtor((x int64) -> { return "s" }, 1).Kind)
    Console.Write(SigInCtor((x int64) -> { return "s" }, 1).Kind)
    Console.Write(Calls.Sig((x int64) -> "s", 1))
    Console.Write(Calls.SigIn((x int64) -> "s", 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.Sig((long x) => { return "s"; }, 1));
        Console.Write(Calls.SigIn((long x) => { return "s"; }, 1));
        Console.Write(new SigCtor((long x) => { return "s"; }, 1).Kind);
        Console.Write(new SigInCtor((long x) => { return "s"; }, 1).Kind);
        Console.Write(Calls.Sig((long x) => "s", 1));
        Console.Write(Calls.SigIn((long x) => "s", 1));
    }
}
`, "OsOsOsOsOsOs")
    }

    /// Issue #5569: an open generic candidate infers its type argument from the literal's natural type, within
    /// its constraints; and a return value that converts to the target does not stop another return value that
    /// does not from selecting `object` with the natural type, as in C#.
    @Fact
    func NaturalLiteral_AtGenericCandidatesAndMixedReturns() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    let flag = true
    Console.Write(Calls.G(() -> { return "s" }, 1))
    Console.Write(Calls.GV(() -> { return "s" }, 1))
    Console.Write(Calls.GC(() -> { return "s" }, 1))
    Console.Write(Calls.G(() -> 1, 1))
    Console.Write(Calls.Dm(() -> {
        if flag {
            return flag ? D() : D()
        }
        return B()
    }, 1))
    Console.Write(Calls.DmIn(() -> {
        if flag {
            return flag ? D() : D()
        }
        return B()
    }, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        var flag = true;
        Console.Write(Calls.G(() => { return "s"; }, 1));
        Console.Write(Calls.GV(() => { return "s"; }, 1));
        Console.Write(Calls.GC(() => { return "s"; }, 1));
        Console.Write(Calls.G(() => 1, 1));
        Console.Write(Calls.Dm(() => { if (flag) { return flag ? new D() : new D(); } return new B(); }, 1));
        Console.Write(Calls.DmIn(() => { if (flag) { return flag ? new D() : new D(); } return new B(); }, 1));
    }
}
`, "G:Func`1G:Func`1G:Func`1FOO")
    }

    /// Issue #5569: a constructor of a generic type with a same-compilation type argument binds the literal by
    /// the same speculative rule, so a literal that its delegate does not accept selects `object`, as in C#.
    @Fact
    func SymbolicConstructorTarget_ThatDoesNotConvert_SelectsObject() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
class Pt {
    var X int32 = 3
}
func Main() {
    Console.Write(SymHolder[Pt]((p Pt) -> { return "s" }, 1).Kind)
    Console.Write(SymInHolder[Pt]((p Pt) -> { return "s" }, 1).Kind)
    Console.Write(SymHolder[Pt]((p Pt) -> p.X, 1).Kind)
    Console.Write(SymInHolder[Pt]((p Pt) -> p.X, 1).Kind)
}
`, `using System;
using FunctionControl;
class Pt { public int X = 3; }
class Program {
    static void Main() {
        Console.Write(new SymHolder<Pt>((Pt p) => { return "s"; }, 1).Kind);
        Console.Write(new SymInHolder<Pt>((Pt p) => { return "s"; }, 1).Kind);
        Console.Write(new SymHolder<Pt>((Pt p) => p.X, 1).Kind);
        Console.Write(new SymInHolder<Pt>((Pt p) => p.X, 1).Kind);
    }
}
`, "OOFF")
    }

    /// Issue #5569 control: with no other candidate, a target-typed block return value keeps the target bind and
    /// its diagnostic.
    @Fact
    func BlockReturnValue_AtTheOnlyCandidate_ReportsTheConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.One(() -> { return {
        let q = "s"
        q
    } }))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.One(() => { var q = "s"; return q; }));
    }
}
`, "CS0029", line: 6, column: 9, length: 1, oracleCompanion: "CS1662")
    }

    /// Issue #5569 control: with no other candidate, an explicit parameter type that the delegate does not accept
    /// keeps its diagnostic.
    @Fact
    func ExplicitParameter_AtTheOnlyCandidate_ReportsTheParameter() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.POne((x int32) -> { return x }))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.POne((int x) => { return x; }));
    }
}
`, "CS1678", line: 4, column: 33, length: 5, diagnostic: "GS0156", oracleCompanion: "CS1661")
    }

    /// Issue #5569 control: with no other candidate, the block-bodied literal keeps the target bind and its
    /// diagnostic at the `return` value.
    @Fact
    func BlockLiteral_AtTheOnlyCandidate_ReportsTheReturnConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.One(() -> { return "s" }))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.One(() => { return "s"; }));
    }
}
`, "CS0029", line: 4, column: 44, length: 3, oracleCompanion: "CS1662")
    }

    /// Issue #5543 controls: a by-value delegate slot, a source `in` slot and an explicit address keep their
    /// selection. A function value still needs a delegate that it can keep (#5536).
    @Fact
    func InDelegateParameter_ValuesAddressesAndSourceSlots_KeepTheirSelection() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func S(in f () -> int64, x int32) string -> "F"
func S(o object, x int64) string -> "O"
func Main() {
    let f () -> int32 = () -> 1
    var g () -> int64 = () -> 2
    Console.Write(Calls.M(() -> 1, 1))
    Console.Write(S(() -> 1, 1))
    Console.Write(Calls.In(f, 1))
    Console.Write(Calls.In(g, 1))
    Console.Write(Calls.In(&g, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static string S(in Func<long> f, int x) => "F";
    static string S(object o, long x) => "O";
    static void Main() {
        Func<int> f = () => 1;
        Func<long> g = () => 2;
        Console.Write(Calls.M(() => 1, 1));
        Console.Write(S(() => 1, 1));
        Console.Write(Calls.In(f, 1));
        Console.Write(Calls.In(g, 1));
        Console.Write(Calls.In(in g, 1));
    }
}
`, "FFOFF")
    }

    /// Issue #5543 control: the `in` pointee target does not decide a call where each `in` candidate is better
    /// for one argument.
    @Fact
    func InDelegateParameter_LiteralThatEachCandidatePrefersOnce_StaysAmbiguous() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
import FunctionControl
func Main() {
    Console.Write(Calls.Amb(() -> 1, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Console.Write(Calls.Amb(() => 1, 1));
    }
}
`, "CS0121", line: 4, column: 25, length: 15, diagnostic: "GS0160")
    }

    @Fact
    func ImportedExtensionReceiver_SkipsFunctionValueThatNeedsAConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
func Main() {
    let f () -> int32 = () -> 1
    let g () -> int64 = () -> 2
    Console.Write(f.M(1))
    Console.Write(E.M(f, 1))
    Console.Write(g.M(1))
    Console.Write(E.M(g, 1))
}
`, `using System;
using FunctionControl;
class Program {
    static void Main() {
        Func<int> f = () => 1;
        Func<long> g = () => 2;
        Console.Write(f.M(1));
        Console.Write(E.M(f, 1));
        Console.Write(g.M(1));
        Console.Write(E.M(g, 1));
    }
}
`, "OOFF")
    }

    @Fact
    func ImportedConstructors_SkipFunctionValueThatNeedsAConversion() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
class Derived : C {
    init(f () -> int32) : base(f, 1) {}
}
func Main() {
    let f () -> int32 = () -> 1
    Console.Write(C(f, 1).Kind)
    Console.Write(Derived(f).Kind)
    Console.Write(C(() -> 1, 1).Kind)
}
`, `using System;
using FunctionControl;
class Derived : C {
    public Derived(Func<int> f) : base(f, 1) {}
}
class Program {
    static void Main() {
        Func<int> f = () => 1;
        Console.Write(new C(f, 1).Kind);
        Console.Write(new Derived(f).Kind);
        Console.Write(new C(() => 1, 1).Kind);
    }
}
`, "OOF")
    }

    @Fact
    func ImplicitDowncast_ReportsCastRequired() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
open class Animal {}
class Dog : Animal {}
func D(a () -> Animal) () -> Dog -> a
func Main() {}
`, `using System;
class Animal {}
class Dog : Animal {}
class Program {
    static Func<Dog> D(Func<Animal> a) => a;
    static void Main() {}
}
`, "CS0266", line: 4, column: 37, length: 1, diagnostic: "GS0156")
    }

    @Fact
    func NullableReferenceResult_ToImportedDelegate_KeepsTheDelegate() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
open class Animal {}
class Dog : Animal {}
func C(x (int32) -> Dog?) Converter[int32, Animal?] -> x
func N(x (int32) -> Dog?) Converter[int32, Animal] -> x
func Main() {
    let f (int32) -> Dog? = (i int32) -> if i > 0 { Dog() } else { nil }
    Console.Write(C(f)(1) is Dog)
    Console.Write(C(f)(0) == nil)
    Console.Write(N(f)(1) is Dog)
}
`, `using System;
class Animal {}
class Dog : Animal {}
class Program {
    static Converter<int, Animal?> C(Func<int, Dog?> x) => new Converter<int, Animal?>(x);
    static Converter<int, Animal> N(Func<int, Dog?> x) => new Converter<int, Animal>(x!);
    static void Main() {
        Func<int, Dog?> f = i => i > 0 ? new Dog() : null;
        Console.Write(C(f)(1) is Dog);
        Console.Write(C(f)(0) == null);
        Console.Write(N(f)(1) is Dog);
    }
}
`, "TrueTrueTrue")
    }

    @Fact
    func CheckedDowncast_KeepsTheDelegateOrThrows() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
open class Animal {}
class Dog : Animal {}
func Main() {
    let d () -> Dog = () -> Dog()
    let a () -> Animal = d
    let back = cast[() -> Dog](a)
    Console.Write(Object.ReferenceEquals(d, back))
    let s () -> string = () -> "s"
    let o () -> object = s
    Console.Write(cast[() -> string](o)())
    let wrong () -> object = () -> 1
    try {
        cast[() -> string](wrong)
        Console.Write("no")
    } catch (InvalidCastException) {
        Console.Write("ICE")
    }
}
`, `using System;
class Animal {}
class Dog : Animal {}
class Program {
    static void Main() {
        Func<Dog> d = () => new Dog();
        Func<Animal> a = d;
        var back = (Func<Dog>)a;
        Console.Write(Object.ReferenceEquals(d, back));
        Func<string> s = () => "s";
        Func<object> o = s;
        Console.Write(((Func<string>)o)());
        Func<object> wrong = () => 1;
        try {
            _ = (Func<string>)wrong;
            Console.Write("no");
        } catch (InvalidCastException) {
            Console.Write("ICE");
        }
    }
}
`, "TruesICE")
    }

    @Fact
    func NumericResult_ExplicitCast_IsRejected() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Reject(fixture, `import System
func C(x () -> int32) () -> int64 -> cast[() -> int64](x)
func Main() {}
`, `using System;
class Program {
    static Func<long> C(Func<int> x) => (Func<long>)x;
    static void Main() {}
}
`, "CS0030", line: 2, column: 56, length: 1)
    }

    @Fact
    func ContravariantParameter_KeepsTheDelegate() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
open class Animal {}
class Dog : Animal {}
func U(x (Animal) -> void) (Dog) -> void -> x
func N(x ((Animal) -> void)?) ((Dog) -> void)? -> x
func Main() {
    let a = (value Animal) -> Console.Write("A")
    let f = U(a)
    f(Dog())
    Console.Write(Object.ReferenceEquals(a, f))
    Console.Write(Object.ReferenceEquals(a, N(a)))
    Console.Write(N(nil) == nil)
}
`, `using System;
class Animal {}
class Dog : Animal {}
class Program {
    static Action<Dog> U(Action<Animal> x) => x;
    static Action<Dog>? N(Action<Animal>? x) => x;
    static void Main() {
        Action<Animal> a = value => Console.Write("A");
        var f = U(a);
        f(new Dog());
        Console.Write(Object.ReferenceEquals(a, f));
        Console.Write(Object.ReferenceEquals(a, N(a)));
        Console.Write(N(null) == null);
    }
}
`, "ATrueTrueTrue")
    }

    @Fact
    func CovariantResult_KeepsTheDelegate() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
open class Animal {}
class Dog : Animal {}
func R(x () -> Dog) () -> Animal -> x
func S(x () -> string) () -> object -> x
func Main() {
    let r = () -> Dog()
    let s = () -> "s"
    Console.Write(Object.ReferenceEquals(r, R(r)))
    Console.Write(Object.ReferenceEquals(s, S(s)))
    Console.Write(S(s)())
}
`, `using System;
class Animal {}
class Dog : Animal {}
class Program {
    static Func<Animal> R(Func<Dog> x) => x;
    static Func<object> S(Func<string> x) => x;
    static void Main() {
        Func<Dog> r = () => new Dog();
        Func<string> s = () => "s";
        Console.Write(Object.ReferenceEquals(r, R(r)));
        Console.Write(Object.ReferenceEquals(s, S(s)));
        Console.Write(S(s)());
    }
}
`, "TrueTrues")
    }

    @Fact
    func DelegateRebindingAndLiteralResults_StillConvert() {
        using let fixture = CSharpFixture(Contract, assemblyName: "FunctionContract", deterministic: true)
        Check(fixture, `import System
import FunctionControl
open class Animal {}
class Dog : Animal {}
delegate MakeAnimal() Animal;
func ToNamed(x () -> Dog) MakeAnimal -> x
func ToImported(x () -> string) Make -> x
func Widen() () -> int64 -> func() int32 { return 7 }
func Abs() (int32) -> int64 -> Math.Abs
func Main() {
    Console.Write(ToNamed(() -> Dog())() is Dog)
    Console.Write(ToImported(() -> "m")())
    Console.Write(Widen()())
    Console.Write(Abs()(-4))
}
`, `using System;
using FunctionControl;
class Animal {}
class Dog : Animal {}
delegate Animal MakeAnimal();
class Program {
    static MakeAnimal ToNamed(Func<Dog> x) => new MakeAnimal(x);
    static Make ToImported(Func<string> x) => new Make(x);
    static Func<long> Widen() => () => { int value = 7; return value; };
    static Func<int, long> Abs() => value => Math.Abs(value);
    static void Main() {
        Console.Write(ToNamed(() => new Dog())() is Dog);
        Console.Write(ToImported(() => "m")());
        Console.Write(Widen()());
        Console.Write(Abs()(-4));
    }
}
`, "Truem74")
    }

    /// Issue #5569: nests a block-bodied literal [`depth`](paramref) times. Each level writes the call of the
    /// level inside it and then returns a string, which does not convert to the delegate's `int64` result.
    /// @param shape The call, with `|` in place of the literal.
    /// @param depth The number of enclosing levels.
    /// @param bodyStart The text that starts a literal body.
    /// @param bodyEnd The `return` statement and the end of a literal body.
    /// @returns The nested call.
    private func NestBlockLiterals(shape string, depth int32, bodyStart string, bodyEnd string) string {
        var call = shape.Replace("|", bodyStart + bodyEnd)
        for var level = 0; level < depth; level++ {
            call = shape.Replace("|", bodyStart + "Console.Write(" + call + ")" + StatementEnd(bodyStart) + bodyEnd)
        }
        return call
    }

    /// Issue #5569: a block value that, at each level, returns the next block from a branch, then gives `"s"`.
    /// @param depth The number of levels.
    /// @returns The block value.
    private func NestReturnBlocks(depth int32) string {
        var value = "{ \"s\" }"
        for var level = 0; level < depth; level++ {
            value = "{\nif flag {\nreturn " + value + "\n}\n\"s\"\n}"
        }
        return value
    }

    /// Issue #5569: an expression-bodied literal with one parameter, nested [`depth`](paramref) times, at a
    /// candidate set whose delegate takes no parameter. No candidate accepts any level.
    /// @param depth The number of enclosing levels.
    /// @param parameter The parameter list.
    /// @param arrow The lambda arrow.
    /// @returns The outermost literal.
    private func NestRejectedLiterals(depth int32, parameter string, arrow string) string {
        var literal = parameter + " " + arrow + " x"
        for var level = 0; level < depth; level++ {
            literal = parameter + " " + arrow + " Calls.N(" + literal + ", 1).Length"
        }
        return literal
    }

    private func StatementEnd(bodyStart string) string -> if bodyStart.Contains("=>") {
        "; "
    } else {
        "\n"
    }

    private func OracleShape(shape string) string -> if shape.StartsWith("Calls.", StringComparison.Ordinal) {
        shape
    } else {
        "new " + shape
    }

    private func Reject(
        fixture CSharpFixture,
        source string,
        oracle string,
        oracleDiagnostic string,
        line int32,
        column int32,
        length int32,
        diagnostic string = "GS0155",
        oracleCompanion string? = nil
    ) {
        output.WriteLine("Contract source:\n" + Contract)
        output.WriteLine("Oracle source:\n" + oracle)
        let compilation = CSharpCompilation.Create(
            "RejectedOracle",
            []SyntaxTree{CSharpSyntaxTree.ParseText(oracle)},
            RuntimeReferences().Concat([]string{fixture.AssemblyPath}).Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ),
            CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable
            )
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.False(emitted.Success)
        // A companion is a second oracle error that Roslyn reports for the same defect.
        let oracleError = Assert.Single(
            emitted.Diagnostics.Where(
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error &&
                    diagnostic.Id != oracleCompanion
            )
        )
        if oracleCompanion != nil {
            Assert.Single(emitted.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Id == oracleCompanion))
        }
        Assert.Equal(oracleDiagnostic, oracleError.Id)
        output.WriteLine("Oracle diagnostic: " + oracleError.ToString())
        for path in OutputPaths(fixture) {
            File.Delete(path)
        }
        let result = Compile(fixture, source)
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal(diagnostic, error.Groups[5].Value)
        Assert.Equal(line.ToString(), error.Groups[1].Value)
        Assert.Equal(column.ToString(), error.Groups[2].Value)
        Assert.Equal(line.ToString(), error.Groups[3].Value)
        Assert.Equal((column + length).ToString(), error.Groups[4].Value)
        for path in OutputPaths(fixture) {
            Assert.False(File.Exists(path))
        }
    }

    private func Check(fixture CSharpFixture, source string, oracle string, expected string) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        output.WriteLine("Contract source:\n" + Contract)
        output.WriteLine("Oracle source:\n" + oracle)
        let result = Compile(fixture, source)
        Assert.True(result.Code == 0, Encoding.UTF8.GetString(result.Bytes) + result.Error)
        Assert.Empty(result.Error)
        let paths = OutputPaths(fixture)
        let bytes = paths.Select((path string) -> File.ReadAllBytes(path)).ToArray()
        for content in bytes {
            Assert.NotEmpty(content)
        }
        let repeat = Compile(fixture, source)
        Assert.Equal(0, repeat.Code)
        Assert.Equal(result.Bytes, repeat.Bytes)
        Assert.Equal(result.Error, repeat.Error)
        for var index = 0; index < paths.Length; index++ {
            Assert.Equal(bytes[index], File.ReadAllBytes(paths[index]))
        }
        let image = paths[0]
        let oraclePath = Path.Combine(fixture.DirectoryPath, "Oracle.dll")
        let compilation = CSharpCompilation.Create(
            "Oracle",
            []SyntaxTree{CSharpSyntaxTree.ParseText(oracle)},
            RuntimeReferences().Concat([]string{fixture.AssemblyPath}).Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ),
            CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable,
                deterministic: true
            )
        )
        let emitted = compilation.Emit(oraclePath)
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        for path in paths.Concat([]string{oraclePath}) {
            RecordArtifact(path)
        }
        File.Copy(
            Path.ChangeExtension(image, ".runtimeconfig.json"),
            Path.ChangeExtension(oraclePath, ".runtimeconfig.json")
        )
        // Strict verification with every reference runs before any image executes.
        Verify(fixture.AssemblyPath, nil)
        Verify(image, fixture.AssemblyPath)
        Verify(oraclePath, fixture.AssemblyPath)
        for executable in[]string{image, oraclePath} {
            let executed = Run([]string{executable})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Bytes)
        }
    }

    private func Compile(fixture CSharpFixture, source string)(Code int32, Bytes[]uint8, Error string) {
        let path = Path.Combine(fixture.DirectoryPath, "Consumer.gs")
        File.WriteAllText(path, source)
        output.WriteLine("G# source:\n" + source)
        RecordArtifact(fixture.AssemblyPath)
        RecordArtifact(typeof(Issue5536FunctionValueConversionDriverTests).Assembly.Location)
        RecordArtifact(typeof(Program).Assembly.Location)
        RecordArtifact(Path.Combine(Path.GetDirectoryName(typeof(Program).Assembly.Location)!!, "GSharp.Core.dll"))
        return Run(
            []string{
                typeof(Program).Assembly.Location,
                path,
                "/target:exe",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:portable",
                "/out:" + Path.Combine(fixture.DirectoryPath, "Consumer.dll"),
                "/refout:" + Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
                "/reference:" + fixture.AssemblyPath
            }
        )
    }

    private func Verify(image string, contract string?) {
        let arguments = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in RuntimeReferences() {
            arguments.Add("-r")
            arguments.Add(path)
        }
        if contract != nil {
            arguments.Add("-r")
            arguments.Add(contract)
        }
        let verified = Run(arguments)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Bytes) + verified.Error)
        Assert.Empty(verified.Error)
    }

    private func Run(arguments IEnumerable[string])(Code int32, Bytes[]uint8, Error string) {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        output.WriteLine("argv: dotnet " + string.Join(" ", arguments))
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
        using let stdout = MemoryStream()
        let read = process.StandardOutput.BaseStream.CopyToAsync(stdout)
        let error = process.StandardError.ReadToEndAsync()
        let exited = process.WaitForExit(30_000)
        if !exited {
            process.Kill(entireProcessTree: true)
        }
        process.WaitForExit()
        read.GetAwaiter().GetResult()
        let stderr = error.GetAwaiter().GetResult()
        output.WriteLine(
            "exit: " + process.ExitCode.ToString() + "; stdout: " + Encoding.UTF8.GetString(stdout.ToArray()) +
                "; stderr: " +
                stderr
        )
        Assert.True(exited, "Function conversion driver exceeded 30 seconds.")
        return (process.ExitCode, stdout.ToArray(), stderr)
    }

    private func RecordArtifact(path string) -> output.WriteLine(
        "SHA256 " + path + ": " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
    )

    shared {
        private func OutputPaths(fixture CSharpFixture)[]string -> []string{
            Path.Combine(fixture.DirectoryPath, "Consumer.dll"),
            Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
            Path.Combine(fixture.DirectoryPath, "Consumer.pdb")
        }

        private func RuntimeReferences()[]string {
            let directory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            return ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where((path string) -> Path.GetDirectoryName(path) == directory)
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
        }

        private const Contract string = `#nullable enable
namespace FunctionControl {
    public delegate long Wide();
    public delegate object Make();
    public static class Calls {
        public static string M(System.Func<long> f, int x) => "F";
        public static string M(object o, long x) => "O";
        public static string In(in System.Func<long> f, int x) => "F";
        public static string In(object o, long x) => "O";
        public static string One(System.Func<long> f) => "F";
        public static string N(System.Func<long> f, int x) => "F";
        public static string N(string s, long x) => "S";
        public static string PV(System.Func<long, long> f, int x) => "F" + f(2);
        public static string PV(object o, long x) => "O";
        public static string POne(System.Func<long, long> f) => "F";
        public static string RR(ref readonly System.Func<long> f, int x) => "F";
        public static string RR(object o, long x) => "O";
        public static string P(in System.Func<long, long> f, int x) => "F" + f(2);
        public static string P(object o, long x) => "O";
        public static string PG<T>(in System.Func<T, T> f, T x) => "F" + f(x);
        public static string PG(object o, string s) => "O";
        public static string Amb(in System.Func<long> f, int x) => "F";
        public static string Amb(in System.Func<int> o, long x) => "O";
        public static string Sig(System.Func<int, long> f, int x) => "F";
        public static string Sig(object o, long x) => Kinds.Of(o);
        public static string SigIn(in System.Func<int, long> f, int x) => "F";
        public static string SigIn(object o, long x) => Kinds.Of(o);
        public static string G(in System.Func<long> f, int x) => "F";
        public static string G<T>(T value, long x) => "G:" + typeof(T).Name;
        public static string GV(System.Func<long> f, int x) => "F";
        public static string GV<T>(T value, long x) => "G:" + typeof(T).Name;
        public static string GC(in System.Func<long> f, int x) => "F";
        public static string GC<T>(T value, long x) where T : class => "G:" + typeof(T).Name;
        public static string Dm(System.Func<System.IDisposable> f, int x) => "F";
        public static string Dm(object o, long x) => "O";
        public static string DmIn(in System.Func<System.IDisposable> f, int x) => "F";
        public static string DmIn(object o, long x) => "O";
    }
    public static class Kinds {
        public static string Of(object o) => o is System.Func<long, string> g ? "O" + g(5) : "O:" + o.GetType();
    }
    public class B { }
    public class D : B, System.IDisposable { public void Dispose() { } }
    public class SigCtor {
        public string Kind;
        public SigCtor(System.Func<int, long> f, int x) { Kind = "F"; }
        public SigCtor(object o, long x) { Kind = Kinds.Of(o); }
    }
    public class SigInCtor {
        public string Kind;
        public SigInCtor(in System.Func<int, long> f, int x) { Kind = "F"; }
        public SigInCtor(object o, long x) { Kind = Kinds.Of(o); }
    }
    public class SymHolder<T> {
        public string Kind;
        public SymHolder(System.Func<T, long> f, int x) { Kind = "F"; }
        public SymHolder(object o, long x) { Kind = "O"; }
    }
    public class SymInHolder<T> {
        public string Kind;
        public SymInHolder(in System.Func<T, long> f, int x) { Kind = "F"; }
        public SymInHolder(object o, long x) { Kind = "O"; }
    }
    public class InReceiver {
        public string M(in System.Func<long> f, int x) => "F";
        public string M(object o, long x) => "O";
    }
    public static class InE {
        public static string X(this InReceiver r, in System.Func<long> f, int x) => "F";
        public static string X(this InReceiver r, object o, long x) => "O";
    }
    public class LitBox<T> {
        public string M(System.Func<T, long> f) => "F";
        public string M(object o) => "O";
    }
    public class InBox<T> {
        public string M(T x, in System.Func<T, int> f) => "B" + f(x);
    }
    public class InHolder<T> {
        public string Kind;
        public InHolder(T x, in System.Func<T, int> f) { Kind = "H" + f(x); }
    }
    public class InStatic<T> {
        public static string S(T x, in System.Func<T, int> f) => "S" + f(x);
    }
    public static class InGeneric {
        public static string Of<T>(T x, in System.Func<T, int> f) => "G" + f(x);
        public static string Each<T>(this System.Collections.Generic.List<T> l, in System.Func<T, int> f) => "E" + f(l[0]);
    }
    public class PCtor {
        public string Kind;
        public PCtor(System.Func<long, long> f, int x) { Kind = "F" + f(2); }
        public PCtor(object o, long x) { Kind = "O"; }
    }
    public class PInCtor {
        public string Kind;
        public PInCtor(in System.Func<long, long> f, int x) { Kind = "F" + f(2); }
        public PInCtor(object o, long x) { Kind = "O"; }
    }
    public class InCtor {
        public string Kind;
        public InCtor(in System.Func<long> f, int x) { Kind = "F"; }
        public InCtor(object o, long x) { Kind = "O"; }
    }
    public static class E {
        public static string M(this System.Func<long> f, int x) => "F";
        public static string M(this object o, long x) => "O";
    }
    public class C {
        public string Kind;
        public C(System.Func<long> f, int x) { Kind = "F"; }
        public C(object o, long x) { Kind = "O"; }
    }
}
`
    }
}
