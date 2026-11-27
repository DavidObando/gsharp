// <copyright file="Issue6242ConditionalLoopNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Tests
import System
import System.Text
import Xunit

/// Issue #6242: omitted `@Conditional` calls inside loop regions must not
/// conservatively destroy loop narrowing, while active calls still do.
class Issue6242ConditionalLoopNarrowingTests {
    @Fact
    func Driver_OmittedConditionalCallInWhileLoop_PreservesLoopNarrowing_AndActiveCallRejects() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        Keep((s = nil))
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(source, "ConditionalLoopWhileAbsent6242", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopWhilePresent6242",
            executable: true,
            "/define:A"
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_OmittedConditionalCall_ScopedUndefineAndDefine_InLoop() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let undefineSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        @UndefineSymbol("A")
        {
            Keep((s = nil))
        }
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(undefineSource, "ConditionalLoopScopedUndef6242", executable: true, "/define:A")
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let defineSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        @DefineSymbol("A")
        {
            Keep((s = nil))
        }
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(defineSource, "ConditionalLoopScopedDef6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_OmittedConditionalCall_AcrossLoopForms_ForPostDoWhileForRange() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func ReadForBody(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 1; i++ {
        Keep((s = nil))
        Console.Write(s.Length)
    }
    return s.Length
}
func ReadForPost(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var i = 0
    for ; i < 1; Keep((s = nil)) {
        Console.Write(s.Length)
        i = 1
    }
    return s.Length
}
func ReadDoWhile(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = false
    do {
        Keep((s = nil))
        Console.Write(s.Length)
    } while once
    return s.Length
}
func ReadForRange(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for _ in []int32{1} {
        Keep((s = nil))
        Console.Write(s.Length)
    }
    return s.Length
}
Console.Write(ReadForBody("ab"))
Console.Write(ReadForPost("cd"))
Console.Write(ReadDoWhile("ef"))
Console.Write(ReadForRange("gh"))`
        let program = fixture.Compile(source, "ConditionalLoopFormsAbsent6242", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("22222222"), fixture.RunBytes(program))

        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopFormsPresent6242",
            executable: true,
            "/define:A"
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_OmittedImportedConditionalCallInLoop_PreservesLoopNarrowing_AndActiveCallRejects() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalLoop6242 {
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void StaticKeep(string? value) {}
    }
    public sealed class InstanceProbe {
        [Conditional("EXT_6242")]
        public void InstanceKeep(string? value) {}
    }
    public static class Extensions {
        [Conditional("EXT_6242")]
        public static void ExtKeep(this string? value) {}
    }
}`, "ConditionalLoopLib6242")
        let source = `import System
import ConditionalLoop6242
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let inst = InstanceProbe()
    var once = true
    while once {
        Probe.StaticKeep((s = nil))
        inst.InstanceKeep((s = nil))
        (s = nil).ExtKeep()
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(source, "ConditionalLoopImportedAbsent6242", executable: true, "/r:" + library)
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopImportedPresent6242",
            executable: true,
            "/r:" + library,
            "/define:EXT_6242"
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_ShadowedLocalCallable_NamedLikeConditional_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let Keep = (v string?) -> {}
    var once = true
    while once {
        Keep((s = nil))
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopShadowed6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_ShadowedCallableRoot_MultiIterationLoop_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
class OmittedProbe {
    @Conditional("A")
    func Keep(value string?) {}
}
class ActiveProbe {
    func Keep(value string?) {}
}
func Make() OmittedProbe -> OmittedProbe()
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let Make = () -> ActiveProbe()
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        Make().Keep((s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopShadowedRoot6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_LoopLocalReceiverTypeTest_WithActiveInstanceMethod_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
class ActiveProbe {
    func Keep(value string?) {}
}
@Conditional("A")
func (self object) Keep(value string?) {}
func Read(probe object, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        if probe is ActiveProbe {
            probe.Keep((s = nil))
        }
    }
    return 0
}
Console.Write(Read(ActiveProbe(), "xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopTypeTest6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_DefaultInterfaceMethod_WithOmittedExtension_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
interface IActiveKeep {
    func Keep(value string?) {}
}
class Impl : IActiveKeep {}
@Conditional("A")
func (self Impl) Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let c = Impl()
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        c.Keep((s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopDefaultIface6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_ConstrainedTypeParameter_WithActiveConstraintMethod_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
interface IActiveKeep {
    func Keep(value string?)
}
class Impl : IActiveKeep {
    func Keep(value string?) {}
}
@Conditional("A")
func (self object) Keep(value string?) {}
func Read[T IActiveKeep](x T, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        x.Keep((s = nil))
    }
    return 0
}
Console.Write(Read(Impl(), "xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopConstraint6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_OverloadedConditionalAndActiveMethods_FiltersInapplicableOverloads() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalOverload6242 {
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void Keep(string? value) {}
        public static void Keep(int value) {}
    }
}`, "ConditionalOverloadLib6242")
        let source = `import System
import System.Diagnostics
import ConditionalOverload6242
@Conditional("A")
func Keep(value string?) {}
func Keep(value int32) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        Keep((s = nil))
        Probe.Keep((s = nil))
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(source, "ConditionalLoopOverloadAbsent6242", executable: true, "/r:" + library)
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (codeSource, outputSource) = fixture.TryCompile(
            source,
            "ConditionalLoopOverloadSourcePresent6242",
            executable: true,
            "/r:" + library,
            "/define:A"
        )
        Assert.NotEqual(0, codeSource)
        Assert.Contains("GS0158", outputSource)

        let (codeImported, outputImported) = fixture.TryCompile(
            source,
            "ConditionalLoopOverloadImportedPresent6242",
            executable: true,
            "/r:" + library,
            "/define:EXT_6242"
        )
        Assert.NotEqual(0, codeImported)
        Assert.Contains("GS0158", outputImported)
    }
}
