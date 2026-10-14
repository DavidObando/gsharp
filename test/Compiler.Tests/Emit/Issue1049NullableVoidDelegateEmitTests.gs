// <copyright file="Issue1049NullableVoidDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1049: emitting a nullable function (delegate) type whose return type
/// is `void` — e.g. `((Args) -> void)?` — crashed the compiler with
/// `GS9998: ArgumentException: The type 'System.Void' may not be used as a
/// type argument`. Issue #1399 / ADR-0137 makes nullable function types use
/// parenthesized spelling, so `(Args) -> void?` remains a nullable return
/// and `((Args) -> void)?` is the nullable delegate. Its underlying return is still
/// `void`, so it must map to `System.Action<...>` rather than
/// the illegal `System.Func<..., System.Void>`.
open class Issue1049NullableVoidDelegateEmitTests {
    @Fact
    func NullableVoidDelegateField_NoArgs_EmitsAsAction() {
        let asm = LoadCompiled(`package p
class C {
    var f (() -> void)?
}`)
        let field FieldInfo? = FindField(asm, "p", "C", "f")
        Assert.Equal("System.Action", field!!.FieldType.FullName)
    }

    @Fact
    func NullableVoidDelegateField_OneArg_EmitsAsActionOfArg() {
        let asm = LoadCompiled(`package p
class C {
    var g ((int32) -> void)?
}`)
        let field FieldInfo? = FindField(asm, "p", "C", "g")
        Assert.True(
            field!!
                .FieldType
                .IsGenericType &&
                field!!
                .FieldType
                .GetGenericTypeDefinition()
                .FullName == "System.Action`1",
            "expected System.Action`1 but was '${field!!.FieldType.FullName}'"
        )
        Assert.Equal(typeof(int32).FullName, field!!.FieldType.GetGenericArguments()[0].FullName)
    }

    @Fact
    func PlainVoidDelegateField_StillEmitsAsAction_RegressionGuard() {
        // Control: the non-nullable `() -> void` shape already mapped to
        // System.Action and must keep doing so after the fix.
        let asm = LoadCompiled(`package p
class C {
    var f () -> void
}`)
        let field FieldInfo? = FindField(asm, "p", "C", "f")
        Assert.Equal("System.Action", field!!.FieldType.FullName)
    }

    @Fact
    func NullableNonVoidReturnDelegateField_StillEmitsAsFunc_RegressionGuard() {
        // Control: a nullable *non-void* return is unaffected — it stays a
        // System.Func<int32, int32> (the `?` annotation on a value-type
        // return shares the underlying CLR representation).
        let asm = LoadCompiled(`package p
class C {
    var h (int32) -> int32?
}`)
        let field FieldInfo? = FindField(asm, "p", "C", "h")
        Assert.True(
            field!!.FieldType.IsGenericType && field!!.FieldType.GetGenericTypeDefinition().FullName == "System.Func`2",
            "expected System.Func`2 but was '${field!!.FieldType.FullName}'"
        )
    }

    shared {
        private func FindField(asm Assembly, ns string, typeName string, fieldName string) FieldInfo? {
            let full = ns + "." + typeName
            let type Type? = asm.GetType(full, throwOnError: false) ?? asm.GetTypes().FirstOrDefault(
                (t Type) -> string.Equals(t.Namespace, ns, StringComparison.Ordinal) && string.Equals(
                    t.Name,
                    typeName,
                    StringComparison.Ordinal
                )
            )
            Assert.NotNull(type)
            let field FieldInfo? = type!!.GetField(
                fieldName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            )
            Assert.NotNull(field)
            return field
        }

        private func LoadCompiled(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1049_").FullName
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
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
            IlVerifier.Verify(outPath)
            let ctx = AssemblyLoadContext(name: "gs_issue1049_" + Guid.NewGuid().ToString(), isCollectible: true)
            return ctx.LoadFromAssemblyPath(outPath)
        }
    }
}
