// <copyright file="Issue2004SharedFieldAccessorVisibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2004: a static computed property whose accessor reads (or writes)
/// a backing field declared in the same `shared{}` block emitted IL that
/// ilverify rejected with `FieldAccess` / "Field is not visible".
///
/// Root cause: `ReflectionMetadataEmitter`'s package-function pass grouped
/// every non-instance (cref:GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol)
/// not already recorded in `aggregateMethodHandles` into the entry-point
/// package's synthesized `<Program>` TypeDef. Plain static methods
/// on a struct/class are added to `aggregateMethodHandles`
/// (`PlanClassMethods`/`PlanStructMethods`), but a static property's
/// (or event's) accessor (cref:GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol)
/// is tracked only via `cache.PropertyAccessorHandles`, keyed by the
/// property symbol — never added to `aggregateMethodHandles`. The
/// unchecked accessor function therefore fell through and was emitted a
/// SECOND time as an ordinary static method on `<Program>`, with a
/// body that still reads/writes the struct/class's static backing field.
/// `<Program>` is an unrelated type, so a private (or otherwise
/// restricted) field access from its duplicated method body is illegal IL —
/// exactly the "Field is not visible" ilverify error. Since
/// `StaticOwnerType` is set to the declaring struct/class for these
/// accessors (mirroring the existing interface static-virtual member check
/// immediately above it), the fix skips them the same way.
///
/// These tests compile and run real programs end-to-end AND ilverify the
/// emitted assembly, covering: a getter-only read, a getter+setter pair
/// (read and write), and a class that mixes an instance property/field with
/// a differently-named static property/field (the shape that most directly
/// reproduces the duplicate `<Program>` emission).
open class Issue2004SharedFieldAccessorVisibilityEmitTests {
    @Fact
    func StaticComputedProperty_ReadsPrivateSharedBlockField_VerifiesAndRuns() {
        let source = `package P
import System

class Issue2004ReadOnly {
    shared {
        private var _name string = "hello"
        prop Name string {
            get { return _name }
        }
    }
}

func Main() {
    Console.WriteLine(Issue2004ReadOnly.Name)
}`
        Assert.Equal("hello${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StaticComputedProperty_GetterAndSetter_ReadWritePrivateSharedBlockField() {
        let source = `package P
import System

class Issue2004GetSet {
    shared {
        private var _name string
        prop Name string {
            get { return _name }
            set { _name = value }
        }
    }
}

func Main() {
    Issue2004GetSet.Name = "world"
    Console.WriteLine(Issue2004GetSet.Name)
}`
        Assert.Equal("world${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InstanceAndStaticComputedProperties_BothOverPrivateFields_VerifyAndRun() {
        // The exact shape that most directly reproduced the bug: a class with
        // BOTH an instance computed property over an instance field AND a
        // (differently-named) static computed property over a shared-block
        // field. Before the fix, the static get_Name/set_Name accessors were
        // duplicated onto the package's synthesized <Program> TypeDef.
        let source = `package P
import System

class Issue2004Mixed {
    private var _label string
    prop Label string {
        get { return _label }
        set { _label = value }
    }

    shared {
        private var _name string
        prop Name string {
            get { return _name }
            set { _name = value }
        }
    }
}

func Main() {
    Issue2004Mixed.Name = "static-value"
    var m = Issue2004Mixed{}
    m.Label = "instance-value"
    Console.WriteLine(Issue2004Mixed.Name)
    Console.WriteLine(m.Label)
}`
        Assert.Equal("static-value${Environment.NewLine}instance-value${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StaticEvent_ExplicitAccessors_ReadWritePrivateSharedBlockField_VerifiesAndRuns() {
        // Generalization of #2004 to events (found in review of PR #2042):
        // static event add/remove/raise accessors created in DeclarationBinder
        // never set StaticOwnerType, so their FunctionSymbols fell through to
        // the package-function loop and were duplicated onto <Program>, whose
        // duplicate body still read/wrote the struct's private shared-block
        // backing field — the same "Field is not visible" ilverify failure
        // as the property case.
        let source = `package P
import System

class Issue2004Event {
    shared {
        private var _handler () -> void
        event Changed () -> void {
            add { _handler = value }
            remove { _handler = _handler }
            raise { _handler() }
        }
    }
}

func Main() {
    Issue2004Event.Changed += func() { Console.WriteLine("added") }
    Issue2004Event.Changed -= func() { }
    Console.WriteLine("done")
}`
        Assert.Equal("done${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2004_").FullName
            try {
                return CompileAndRunImpl(source, tempDir)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunImpl(source string, tempDir string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
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
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(outPath)
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
