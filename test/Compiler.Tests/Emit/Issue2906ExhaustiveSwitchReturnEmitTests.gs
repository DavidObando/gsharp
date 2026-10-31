// <copyright file="Issue2906ExhaustiveSwitchReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2906: exhaustive closed-type switches can satisfy definite return,
/// while ordinary switch statements retain unmatched-value fallthrough.
/// Asserts the emitted program only; the interpreter parity arm was retired
/// with the evaluator in ADR-0156 Phase 3c (#3176).
open class Issue2906ExhaustiveSwitchReturnEmitTests {
    @Theory
    @MemberData("Cases")
    func ExhaustiveSwitch_VerifiesLoadsAndRuns(name string, expected int32, source string) {
        let assembly = CompileVerifyLoadAndRun(name, source)
        Assert.Equal(expected, GetField(assembly, "result"))
    }

    @Theory
    @MemberData("FallthroughCases")
    func ExhaustiveSwitchStatement_UnmatchedValueFallsThrough(name string, expected int32, source string) {
        let assembly = CompileVerifyLoadAndRun(name, source)
        Assert.Equal(expected, GetField(assembly, "result"))
    }

    @Fact
    func ExhaustiveEnum_UnnamedRuntimeValue_ThrowsDefensively() {
        const Source = `package Issue2906.EmitUnnamed
import System
enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
    }
}
public var result = 0
try {
    F(E(99))
} catch (ex InvalidOperationException) {
    result = ex.Message == "__NON_VOID_FALLTHROUGH_GUARD__"
        ? 7
        : -1
}`
        let assembly = CompileVerifyLoadAndRun("Unnamed", WithGuardMessage(Source))
        Assert.Equal(7, GetField(assembly, "result"))
    }

    @Fact
    func ExhaustiveEnum_UnnamedValueWithFixedReturn_ThrowsDefensively() {
        const Source = `package Issue2906.EmitUnnamedFixed
import System
func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
public var result = 0
try {
    F(DateTimeKind(99), []int32{7})
} catch (ex InvalidOperationException) {
    result = ex.Message == "__NON_VOID_FALLTHROUGH_GUARD__"
        ? 7
        : -1
}`
        let assembly = CompileVerifyLoadAndRun(
            "UnnamedFixed",
            WithGuardMessage(Source),
            ignoredVerificationErrors: []string{"UnmanagedPointer", "StackByRef"},
            ignoredVerificationScope: "<Program>\\.F$$"
        )
        Assert.Equal(7, GetField(assembly, "result"))
    }

    shared {
        /// Gets exhaustive switch programs and their expected result.
        func Cases() sequence[[]object] {
            yield Case("OneMember", 1, `enum E { A }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
    }
}
public var result = F(E.A)`)
            yield Case("TwoMembers", 3, `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
    }
}
public var result = F(E.A) + F(E.B)`)
            yield Case("ManyMembers", 10, `enum E { A, B, C, D }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
        case E.C { return 3 }
        case E.D { return 4 }
    }
}
public var result = F(E.A) + F(E.B) + F(E.C) + F(E.D)`)
            yield Case("RedundantDefault", 2, `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
        default { return 3 }
    }
}
public var result = F(E.B)`)
            yield Case("DuplicateCompleteArms", 4, `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.A { return 2 }
        case E.B { return 3 }
    }
}
public var result = F(E.A) + F(E.B)`)
            yield Case("OrPattern", 3, `enum E { A, B, C }
func F(x E) int32 {
    switch x {
        case E.A or E.B { return 1 }
        case E.C { return 2 }
    }
}
public var result = F(E.B) + F(E.C)`)
            yield Case("SealedInterface", 3, `sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func F(x Expr) int32 {
    switch x {
        case _ is Add { return 1 }
        case _ is Mul { return 2 }
    }
}
public var result = F(Add()) + F(Mul())`)
            yield Case("SealedClass", 3, `sealed class Shape { }
class Circle : Shape { }
class Square : Shape { }
func F(x Shape) int32 {
    switch x {
        case _ is Circle { return 1 }
        case _ is Square { return 2 }
    }
}
public var result = F(Circle()) + F(Square())`)
            yield Case("SwitchInsideTry", 2, `enum E { A, B }
func F(x E) int32 {
    try {
        switch x {
            case E.A { return 1 }
            case E.B { return 2 }
        }
    } finally {
    }
}
public var result = F(E.B)`)
            yield Case("TryInsideArms", 3, `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A {
            try {
                return 1
            } finally {
            }
        }
        case E.B {
            try {
                return 2
            } finally {
            }
        }
    }
}
public var result = F(E.A) + F(E.B)`)
            yield Case("SwitchInsideSelect", 2, `enum E { A, B }
func F(x E) int32 {
    select {
        default {
            switch x {
                case E.A { return 1 }
                case E.B { return 2 }
            }
        }
    }
}
public var result = F(E.B)`)
        }

        /// Gets exhaustive switch statements whose unmatched runtime value must fall through.
        func FallthroughCases() sequence[[]object] {
            yield Case("ReturnAfterSwitch", 99, `import System
func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 1 }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
    return 99
}
public var result = F(DateTimeKind(99))
result`)
            yield Case("NonTerminalArms", 0, `import System
func F(x DateTimeKind) int32 {
    var value = 0
    switch x {
        case DateTimeKind.Unspecified { value = 1 }
        case DateTimeKind.Utc { value = 2 }
        case DateTimeKind.Local { value = 3 }
    }
    return value
}
public var result = F(DateTimeKind(99))
result`)
            yield Case("VoidFunctionContinues", 7, `import System
func F(x DateTimeKind, out value int32) {
    switch x {
        case DateTimeKind.Unspecified { value = 1 }
        case DateTimeKind.Utc { value = 2 }
        case DateTimeKind.Local { value = 3 }
    }
    value = 7
}
var result int32
F(DateTimeKind(99), &result)
result`)
            yield Case("CapturedArmState", 0, `import System
func F(x DateTimeKind) int32 {
    var value = 0
    let read = func() int32 { return value }
    switch x {
        case DateTimeKind.Unspecified { value = 1 }
        case DateTimeKind.Utc { value = 2 }
        case DateTimeKind.Local { value = 3 }
    }
    return read()
}
public var result = F(DateTimeKind(99))
result`)
            yield Case("SealedInterfaceNil", 0, `sealed interface Expr { }
class Literal : Expr { }
func F(x Expr) int32 {
    switch x {
        case _ is Literal { return 1 }
    }
    return 0
}
public var result = F(default(Expr))
result`)
        }

        private func Case(name string, expected int32, body string)[]object -> []object{
            name,
            expected,
            "package Issue2906.Emit$name${Environment.NewLine}$body"
        }

        private func WithGuardMessage(source string) string -> source.Replace(
            "__NON_VOID_FALLTHROUGH_GUARD__",
            DiagnosticDescriptors.NonVoidFallthroughGuardMessage,
            StringComparison.Ordinal
        )

        private func CompileVerifyLoadAndRun(
            name string,
            source string,
            ignoredVerificationErrors IEnumerable[string]? = nil,
            ignoredVerificationScope string? = nil
        ) Assembly {
            using let peStream = MemoryStream()
            let result = Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let bytes = peStream.ToArray()
            let assemblyPath = Path.Combine(
                Directory.GetCurrentDirectory(),
                "Issue2906_${name}_${Guid.NewGuid():N}.dll"
            )
            try {
                File.WriteAllBytes(assemblyPath, bytes)
                IlVerifier.Verify(
                    assemblyPath,
                    ignoredErrorCodes: ignoredVerificationErrors,
                    ignoredErrorScope: ignoredVerificationScope
                )
            } finally {
                File.Delete(assemblyPath)
            }
            let assembly = EmittedFixture.Load(bytes)
            let types = assembly.GetTypes()
            Assert.NotEmpty(types)
            let program = types.Single((type Type) -> type.Name == "<Program>")
            let entry = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Run(
                () -> entry.Invoke(
                    nil,
                    if entry.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            )
            Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), "$name execution timed out")
            return assembly
        }

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
