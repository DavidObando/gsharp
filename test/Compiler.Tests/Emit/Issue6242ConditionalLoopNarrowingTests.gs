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

    @Theory
    @InlineData(
        "forBody",
        "for var i = 0; i < 1; i++ {\n        Keep((s = nil))\n        Console.Write(s.Length)\n    }",
        10,
        12
    )
    @InlineData(
        "forPost",
        "var i = 0\n    for ; i < 1; Keep((s = nil)) {\n        Console.Write(s.Length)\n        i = 1\n    }",
        10,
        13
    )
    @InlineData(
        "doWhile",
        "var once = false\n    do {\n        Keep((s = nil))\n        Console.Write(s.Length)\n    } while once",
        11,
        13
    )
    @InlineData(
        "forRange",
        "for _ in []int32{1} {\n        Keep((s = nil))\n        Console.Write(s.Length)\n    }",
        10,
        12
    )
    func Driver_OmittedConditionalCall_AcrossIsolatedLoopForms(
        formName string,
        loopBody string,
        insideReadLine int32,
        afterReadLine int32
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    ` + loopBody + `
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(source, "ConditionalLoop_" + formName + "_Absent6242", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoop_" + formName + "_Present6242",
            executable: true,
            "/define:A"
        )
        Assert.NotEqual(0, code)
        Assert.Contains("(" + insideReadLine.ToString() + ",", output)
        Assert.Contains("(" + afterReadLine.ToString() + ",", output)
        Assert.Contains("GS0158", output)
    }

    @Theory
    @InlineData("static", "Probe.StaticKeep((s = nil))")
    @InlineData("instance", "inst.InstanceKeep((s = nil))")
    @InlineData("extension", "(s = nil).ExtKeep()")
    func Driver_OmittedImportedConditionalCallInLoop_IsolatedRoutes_PreserveAndRejectAtExactLocations(
        routeName string,
        callStatement string
    ) {
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
}`, "ConditionalLoopLib_" + routeName + "_6242")
        let source = `import System
import ConditionalLoop6242
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let inst = InstanceProbe()
    var once = true
    while once {
        ` + callStatement + `
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(
            source,
            "ConditionalLoopImported_" + routeName + "_Absent6242",
            executable: true,
            "/r:" + library
        )
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopImported_" + routeName + "_Present6242",
            executable: true,
            "/r:" + library,
            "/define:EXT_6242"
        )
        Assert.NotEqual(0, code)
        Assert.Contains("(10,", output)
        Assert.Contains("(13,", output)
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

    @Fact
    func Driver_NestedLoopUnderEnclosingReceiverTypeTest_StillRejectsWithGS0158() {
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
            var once = true
            while once {
                probe.Keep((s = nil))
                once = false
            }
        }
    }
    return 0
}
Console.Write(Read(ActiveProbe(), "xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopNestedTypeTest6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_BodyLocalShadowedAndSmartCastArgument_OverloadSelection_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let shadowedSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(tag string, value string?) {}
func Keep(tag int32, value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let tag = "x"
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        let tag = 1
        Keep(tag, (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (codeShadow, outputShadow) = fixture.TryCompile(
            shadowedSource,
            "ConditionalLoopShadowedArg6242",
            executable: true
        )
        Assert.NotEqual(0, codeShadow)
        Assert.Contains("GS0158", outputShadow)

        let smartCastSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(tag object, value string?) {}
func Keep(tag int32, value string?) {}
func Read(tag object, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        if tag is int32 {
            Keep(tag, (s = nil))
        }
    }
    return 0
}
Console.Write(Read(1, "xy"))`
        let (codeSmart, outputSmart) = fixture.TryCompile(
            smartCastSource,
            "ConditionalLoopSmartCastArg6242",
            executable: true
        )
        Assert.NotEqual(0, codeSmart)
        Assert.Contains("GS0158", outputSmart)
    }

    @Fact
    func Driver_ConstantNarrowingOverloads_PreservesActiveRejection_AndAllowsOmittedByteOverload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let activeSource = `import System
import System.Diagnostics
class Probe {
    func Keep(value string?, b uint8) {}
}
@Conditional("A")
func (self Probe) Keep(value string?, b object) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let probe = Probe()
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        probe.Keep((s = nil), 1)
    }
    return 0
}
Console.Write(Read("xy"))`
        let (codeActive, outputActive) = fixture.TryCompile(
            activeSource,
            "ConditionalLoopConstNarrowActive6242",
            executable: true
        )
        Assert.NotEqual(0, codeActive)
        Assert.Contains("GS0158", outputActive)

        let omittedSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(value string?, b uint8) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        Keep((s = nil), 1)
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(omittedSource, "ConditionalLoopConstNarrowOmitted6242", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))
    }

    @Fact
    func Driver_AssignmentResultTypeAndBetterOverload_AllowsOmittedStringOverload_OverObjectOverload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalBetterOverload6242 {
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void Keep(string? value) {}
        public static void Keep(object? value) {}
        [Conditional("EXT_6242")]
        public static void KeepGeneric<T>(string? value) {}
        public static void KeepGeneric(string? value) {}
    }
}`, "ConditionalBetterOverloadLib6242")
        let source = `import System
import System.Diagnostics
import ConditionalBetterOverload6242
@Conditional("A")
func Keep(value string?) {}
func Keep(value object?) {}
@Conditional("A")
func KeepGeneric[T](value string?) {}
func KeepGeneric(value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var once = true
    while once {
        Keep((s = nil))
        Probe.Keep((s = nil))
        KeepGeneric[int32]((s = nil))
        Probe.KeepGeneric[int32]((s = nil))
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(
            source,
            "ConditionalLoopBetterOverloadAbsent6242",
            executable: true,
            "/r:" + library
        )
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))

        let (codeSource, outputSource) = fixture.TryCompile(
            source,
            "ConditionalLoopBetterOverloadSourcePresent6242",
            executable: true,
            "/r:" + library,
            "/define:A"
        )
        Assert.NotEqual(0, codeSource)
        Assert.Contains("GS0158", outputSource)

        let (codeImported, outputImported) = fixture.TryCompile(
            source,
            "ConditionalLoopBetterOverloadImportedPresent6242",
            executable: true,
            "/r:" + library,
            "/define:EXT_6242"
        )
        Assert.NotEqual(0, codeImported)
        Assert.Contains("GS0158", outputImported)
    }

    @Fact
    func Driver_PrecedingAssignmentAndNullCoalescingArg_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let priorStmtSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(tag object?, value string?) {}
func Keep(tag string, value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var tag string? = nil
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        tag = "x"
        Keep(tag, (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (codePrior, outputPrior) = fixture.TryCompile(
            priorStmtSource,
            "ConditionalLoopPriorAssign6242",
            executable: true
        )
        Assert.NotEqual(0, codePrior)
        Assert.Contains("GS0158", outputPrior)

        let priorArgSource = `import System
import System.Diagnostics
@Conditional("A")
func Keep(first string, tag object?, value string?) {}
func Keep(first string, tag string, value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var tag string? = nil
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        Keep(tag ??= "x", tag, (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (codeArg, outputArg) = fixture.TryCompile(
            priorArgSource,
            "ConditionalLoopPriorArgAssign6242",
            executable: true
        )
        Assert.NotEqual(0, codeArg)
        Assert.Contains("GS0158", outputArg)
    }

    @Fact
    func Driver_PrivateInterfaceHelper_WithOmittedExtension_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
interface IHelper {
    private func Keep(value string?) {}
    func Read(input string?) int32 {
        var s = input
        if s == nil { return 0 }
        for var i = 0; i < 2; i++ {
            Console.Write(s.Length)
            this.Keep((s = nil))
        }
        return 0
    }
}
@Conditional("A")
func (self IHelper) Keep(value string?) {}
class Impl : IHelper {}
Console.Write(Impl().Read("xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopPrivateIfaceHelper6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_ReceiverChainWrite_MakesLaterArgumentUncertain_AndRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func (self string?) Keep(tag object?, value string?) {}
func (self string?) Keep(tag string, value string?) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    var tag string? = nil
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        (tag = "x").Keep(tag, (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopRecvWrite6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_ConstructedImportedGenericReceiver_WithSourceTypeArg_StillRejectsActiveInstanceMethod() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalGenericBox6242 {
    public sealed class Box<T> {
        public void Keep(T value) {}
    }
}`, "ConditionalGenericBoxLib6242")
        let source = `import System
import System.Diagnostics
import ConditionalGenericBox6242
class Payload {
    var Value int32 = 1
}
@Conditional("A")
func (self object) Keep(value Payload?) {}
func Read(input Payload?) int32 {
    var p = input
    if p == nil { return 0 }
    let box = Box[Payload?]()
    for var i = 0; i < 2; i++ {
        Console.Write(p.Value)
        box.Keep((p = nil))
    }
    return 0
}
Console.Write(Read(Payload()))`
        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopGenericBox6242",
            executable: true,
            "/r:" + library
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_UserDefinedConversionOverload_DoesNotPruneActiveReferenceConversionOverload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalConvRank6242 {
    public class Base {}
    public class Derived : Base {}
    public class Source : Base {
        public static implicit operator Derived(Source s) => new Derived();
    }
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void Keep(Derived d, string? value) {}
        public static void Keep(Base b, string? value) {}
    }
}`, "ConditionalConvRankLib6242")
        let source = `import System
import ConditionalConvRank6242
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let x = Source()
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        Probe.Keep(x, (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopConvRank6242",
            executable: true,
            "/r:" + library
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_OmittedInstanceMethod_BeatsActiveExtension_AndExactInt32BeatsActiveByte() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalExactRank6242 {
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void Keep(string? value, int n) {}
        public static void Keep(string? value, byte n) {}
    }
}`, "ConditionalExactRankLib6242")
        let source = `import System
import System.Diagnostics
import ConditionalExactRank6242
class Holder {
    @Conditional("A")
    func Keep(value string?) {}
}
func (self Holder) Keep(value string?) {}
@Conditional("A")
func KeepNum(value string?, n int32) {}
func KeepNum(value string?, n uint8) {}
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let h = Holder()
    var once = true
    while once {
        h.Keep((s = nil))
        KeepNum((s = nil), 1)
        Probe.Keep((s = nil), 1)
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read("xy"))`
        let program = fixture.Compile(
            source,
            "ConditionalLoopExactAndInstAbsent6242",
            executable: true,
            "/r:" + library
        )
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))
    }

    @Fact
    func Driver_NullGuardNarrowingInLoop_RetainsActiveNonNullOverload_AndRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Diagnostics
@Conditional("A")
func Keep(tag object?, value string?) {}
func Keep(tag string, value string?) {}
func Read(tag string?, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        if tag != nil {
            Keep(tag, (s = nil))
        }
    }
    return 0
}
Console.Write(Read("x", "xy"))`
        let (code, output) = fixture.TryCompile(source, "ConditionalLoopNullGuardArg6242", executable: true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_InaccessiblePrivateConditionalOverload_DoesNotDominatePublicActiveOverload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalVisibility6242 {
    public sealed class Probe {
        [Conditional("EXT_6242")]
        private void Keep(string? a, string? b) {}
        public void Keep(object? a, string? b) {}
    }
}`, "ConditionalVisibilityLib6242")
        let source = `import System
import ConditionalVisibility6242
func Read(input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let p = Probe()
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        p.Keep("x", (s = nil))
    }
    return 0
}
Console.Write(Read("xy"))`
        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopVisibility6242",
            executable: true,
            "/r:" + library
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_NullableWrappingDoesNotDominateBoxing_StillRejectsWithGS0158() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System;
using System.Diagnostics;
namespace ConditionalBoxVsWrap6242 {
    public static class Probe {
        [Conditional("EXT_6242")]
        public static void Keep(DateTime? d, string? value) {}
        public static void Keep(object? d, string? value) {}
    }
}`, "ConditionalBoxVsWrapLib6242")
        let source = `import System
import ConditionalBoxVsWrap6242
func Read(stamp DateTime, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    for var i = 0; i < 2; i++ {
        Console.Write(s.Length)
        Probe.Keep(stamp, (s = nil))
    }
    return 0
}
Console.Write(Read(DateTime.UnixEpoch, "xy"))`
        let (code, output) = fixture.TryCompile(
            source,
            "ConditionalLoopBoxVsWrap6242",
            executable: true,
            "/r:" + library
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Driver_NamedArguments_AbstractExplicitInterface_AndNumericSignedRanking_PreserveNarrowing() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable enable
using System.Diagnostics;
namespace ConditionalRound5Accept6242 {
    public interface IKeep {
        void Keep(string? value);
    }
    public sealed class Holder : IKeep {
        [Conditional("EXT_6242")]
        public void Keep(object? value) {}
        void IKeep.Keep(string? value) {}
    }
    public static class NumericProbe {
        [Conditional("EXT_6242")]
        public static void Keep(string? value, long n) {}
        public static void Keep(string? value, ulong n) {}
    }
}`, "ConditionalRound5AcceptLib6242")
        let source = `import System
import System.Diagnostics
import ConditionalRound5Accept6242
@Conditional("A")
func KeepNamed(value string?) {}
func KeepNamed(value int32) {}
@Conditional("A")
func KeepNum(value string?, n int64) {}
func KeepNum(value string?, n uint64) {}
func Read(n uint32, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    let h = Holder()
    var once = true
    while once {
        KeepNamed(value: (s = nil))
        h.Keep((s = nil))
        KeepNum((s = nil), n)
        NumericProbe.Keep((s = nil), n)
        Console.Write(s.Length)
        once = false
    }
    return s.Length
}
Console.Write(Read(1, "xy"))`
        let program = fixture.Compile(source, "ConditionalLoopRound5Accept6242", executable: true, "/r:" + library)
        IlVerifier.Verify(program, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("22"), fixture.RunBytes(program))
    }
}
