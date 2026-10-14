// <copyright file="GlobalVariableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #191 emit tests. Compiles GSharp sources declaring top-level
/// `var` / `let` / `const` and asserts that the resulting PE
/// contains a CLR `FieldDef` on the entry-point package's
/// `<Program>` TypeDef carrying the correct accessibility, that
/// mutable load/store sites round-trip through `ldsfld`/`stsfld`,
/// constants carry CLR literal metadata, and annotations on globals survive as
/// `CustomAttribute` rows.
///
/// Non-constant `let` globals remain regular static fields (not
/// `initonly`): enforcing init-only storage would require hoisting their
/// initialization into a `.cctor`, changing observable top-level ordering.
open class GlobalVariableEmitTests {
    @Fact
    func TopLevel_Var_Emits_As_Public_Static_Field_On_Program() {
        let source = `package P
import System

public var counter = 0`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let field FieldInfo? = program.GetField("counter", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(field)
        Assert.Equal(typeof(int32), field!!.FieldType)
        Assert.True(field!!.IsStatic)
        Assert.True(field!!.IsPublic)
        Assert.False(field!!.IsInitOnly)
    }

    @Fact
    func TopLevel_Internal_Var_Maps_To_Assembly_Visibility() {
        let source = `package P
import System

internal var counter = 0`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let field FieldInfo? = program.GetField("counter", BindingFlags.NonPublic | BindingFlags.Static)
        Assert.NotNull(field)
        Assert.True(field!!.IsAssembly, "internal must map to FieldAttributes.Assembly.")
    }

    @Fact
    func TopLevel_Private_Var_Maps_To_Private_Visibility() {
        let source = `package P
import System

private var counter = 0`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let field FieldInfo? = program.GetField("counter", BindingFlags.NonPublic | BindingFlags.Static)
        Assert.NotNull(field)
        Assert.True(field!!.IsPrivate, "private must map to FieldAttributes.Private.")
    }

    @Fact
    func TopLevel_Let_EmitsAsStaticField_AndConstEmitsAsLiteral() {
        let source = `package P
import System

public let greeting = "hi"
public const answer = 42`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let greeting FieldInfo? = program.GetField("greeting", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(greeting)
        Assert.Equal(typeof(string), greeting!!.FieldType)
        Assert.False(greeting!!.IsLiteral)
        let answer FieldInfo? = program.GetField("answer", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(answer)
        Assert.Equal(typeof(int32), answer!!.FieldType)
        Assert.True(answer!!.IsLiteral)
        Assert.Equal(42, answer!!.GetRawConstantValue())
    }

    @Fact
    func Obsolete_On_Global_Var_Round_Trips_As_CustomAttribute() {
        let source = `package P
import System

@Obsolete("use newCounter")
public var counter = 0`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let field FieldInfo? = program.GetField("counter", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(field)
        let data = field!!.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("use newCounter", arg.Value)
    }

    @Fact
    func TopLevel_Var_Mutated_By_Function_Reads_Through_Ldsfld_Stsfld() {
        // Smoke test: a top-level var written by a non-entry function then
        // read by another function must round-trip through static-field
        // load/store. If the global were still a local, bump() would write
        // into a temporary slot and the read would return 0.
        let source = `package P
import System

public var counter = 0

public func bump() {
    counter = counter + 1
}

public func current() int32 {
    return counter
}`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let counter FieldInfo? = program.GetField("counter", BindingFlags.Public | BindingFlags.Static)
        let bump MethodInfo? = program.GetMethod("bump", BindingFlags.Public | BindingFlags.Static)
        let current MethodInfo? = program.GetMethod("current", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(counter)
        Assert.NotNull(bump)
        Assert.NotNull(current)
        bump!!.Invoke(nil, nil)
        bump!!.Invoke(nil, nil)
        Assert.Equal(2, int32(current!!.Invoke(nil, nil)!!))
        Assert.Equal(2, int32(counter!!.GetValue(nil)!!))
    }

    @Fact
    func TopLevel_Var_Read_And_Written_From_EntryPoint_Round_Trips_Through_Static_Field() {
        // Issue #408 regression: top-level statements compiled into <Main>$
        // must read and write a global through ldsfld/stsfld, not allocate a
        // local slot. Symptom before the fix: a top-level `var x = "a"` would
        // emit `stloc.0` in <Main>$, so a mutation done by a function (which
        // correctly uses stsfld) was invisible to subsequent <Main>$ reads.
        let source = `package P
import System

public var trace = ""

public func bump() {
    trace = trace + "x,"
}

bump()
bump()`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(entry)
        Assert.NotNull(traceField)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("x,x,", cast[string](traceField!!.GetValue(nil)!!))
    }

    @Fact
    func TopLevel_Var_Address_From_EntryPoint_Uses_Ldsflda() {
        // Issue #408 regression sibling: a top-level `&counter` (e.g. passed
        // to Interlocked.CompareExchange) must use ldsflda, not ldloca, when
        // emitted from <Main>$.
        let source = `package P
import System
import System.Threading

public var counter = 0
Interlocked.CompareExchange(&counter, 7, 0)`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let counterField FieldInfo? = program.GetField("counter", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(entry)
        Assert.NotNull(counterField)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(7, int32(counterField!!.GetValue(nil)!!))
    }

    shared {
        private func CompileToAssembly(source string) Assembly -> CompileToAssembly(source, target: "exe")

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_global_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }
    }
}
