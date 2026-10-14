// <copyright file="Issue3058OutParameterMemberDefiniteAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3058: out-parameter definite assignment must run for every function
/// body without rejecting calls that definitely assign the parameter. The
/// diagnostics are compile-time binder analysis; the matrix crosses each case
/// with the whole-program emit path and the REPL submission path (the
/// tree-walking evaluator driver retired in ADR-0156 Phase 3c, #3176).
open class Issue3058OutParameterMemberDefiniteAssignmentTests {
    @Theory
    @MemberData("FalsePositiveMatrix")
    func FalsePositiveCorpus_AssignedOnEveryPath_HasNoDiagnostics(
        name string,
        source string,
        position SourcePosition,
        driver Issue3058OutParameterMemberDefiniteAssignmentTests.Driver
    ) {
        let errors = Compile(WithPositionProbe(source, position), driver)
        Assert.True(
            errors.Length == 0,
            "$name/$position/$driver:${Environment.NewLine}${string.Join(Environment.NewLine, errors.Select((error GSharp.Core.CodeAnalysis.Diagnostic) -> error.ToString()))}"
        )
    }

    @Theory
    @MemberData("TruePositiveMatrix")
    func TruePositiveCorpus_MissingAssignment_ReportsSingleGS0238(
        name string,
        source string,
        position SourcePosition,
        driver Issue3058OutParameterMemberDefiniteAssignmentTests.Driver
    ) {
        let errors = Compile(WithPositionProbe(source, position), driver)
        Assert.True(
            errors.Length == 1,
            "$name/$position/$driver:${Environment.NewLine}${string.Join(Environment.NewLine, errors.Select((error GSharp.Core.CodeAnalysis.Diagnostic) -> error.ToString()))}"
        )
        Assert.Equal("GS0238", errors[0].Id)
    }

    @Theory
    @MemberData("RefReadMatrix")
    func RefReadCorpus_MissingAssignment_ReportsSingleGS0239(
        name string,
        source string,
        position SourcePosition,
        driver Issue3058OutParameterMemberDefiniteAssignmentTests.Driver
    ) {
        let errors = Compile(WithPositionProbe(source, position), driver)
        Assert.True(
            errors.Length == 1,
            "$name/$position/$driver:${Environment.NewLine}${string.Join(Environment.NewLine, errors.Select((error GSharp.Core.CodeAnalysis.Diagnostic) -> error.ToString()))}"
        )
        Assert.Equal("GS0239", errors[0].Id)
    }

    /// Source execution position.
    enum SourcePosition {
        TopLevel,
        InFunction
    }

    /// Compiler driver path.
    enum Driver {
        Emit,
        Submission
    }

    private data class SourceCase(Name string, ValidSource string, InvalidSource string? = nil) : IEquatable[
        SourceCase
    ] { }

    shared {
        /// Gets valid programs crossed with source position and driver.
        /// @returns Test rows.
        func FalsePositiveMatrix() sequence[[]object] {
            for sourceCase in DeclarationCases().Concat(CallCases()) {
                for position in Enum.GetValues[SourcePosition]() {
                    for driver in Enum.GetValues[Issue3058OutParameterMemberDefiniteAssignmentTests.Driver]() {
                        yield[]object{sourceCase.Name, sourceCase.ValidSource, position, driver}
                    }
                }
            }
        }

        /// Gets invalid programs crossed with source position and driver.
        /// @returns Test rows.
        func TruePositiveMatrix() sequence[[]object] {
            for sourceCase in DeclarationCases() {
                for position in Enum.GetValues[SourcePosition]() {
                    for driver in Enum.GetValues[Issue3058OutParameterMemberDefiniteAssignmentTests.Driver]() {
                        yield[]object{sourceCase.Name, sourceCase.InvalidSource!!, position, driver}
                    }
                }
            }
        }

        /// Gets invalid ref-read programs crossed with source position and driver.
        /// @returns Test rows.
        func RefReadMatrix() sequence[[]object] {
            for sourceCase in CallCases().Where((sourceCase SourceCase) -> sourceCase.InvalidSource != nil) {
                for position in Enum.GetValues[SourcePosition]() {
                    for driver in Enum.GetValues[Issue3058OutParameterMemberDefiniteAssignmentTests.Driver]() {
                        yield[]object{sourceCase.Name, sourceCase.InvalidSource!!, position, driver}
                    }
                }
            }
        }

        private func DeclarationCases() sequence[SourceCase] {
            yield SourceCase("TopLevelFunction", `func TryIt(out r int32) bool {
    r = 11
    return true
}`, `func TryIt(out r int32) bool {
    return true
}`)
            yield SourceCase("ClassSharedMethod", `class Holder {
    shared {
        func TryIt(out r int32) bool {
            r = 11
            return true
        }
    }
}`, `class Holder {
    shared {
        func TryIt(out r int32) bool {
            return true
        }
    }
}`)
            yield SourceCase("ClassInstanceMethod", `class Holder {
    func TryIt(out r int32) bool {
        r = 11
        return true
    }
}`, `class Holder {
    func TryIt(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("StructInstanceMethod", `struct Holder {
    func TryIt(out r int32) bool {
        r = 11
        return true
    }
}`, `struct Holder {
    func TryIt(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("DataStructInstanceMethod", `data struct Holder {
    func TryIt(out r int32) bool {
        r = 11
        return true
    }
}`, `data struct Holder {
    func TryIt(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("DefaultInterfaceMethod", `interface IHolder {
    func TryIt(out r int32) bool {
        r = 11
        return true
    }
}`, `interface IHolder {
    func TryIt(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("NestedClassMethod", `class Outer {
    class Holder {
        func TryIt(out r int32) bool {
            r = 11
            return true
        }
    }
}`, `class Outer {
    class Holder {
        func TryIt(out r int32) bool {
            return true
        }
    }
}`)
            yield SourceCase("LocalFunction", `func Outer() {
    let TryIt[T] = func(out r int32) bool {
        r = 11
        return true
    }
}`, `func Outer() {
    let TryIt[T] = func(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("Lambda", `delegate TryDelegate(out r int32) bool;
func Outer() {
    let tryIt TryDelegate = (out r int32) -> {
        r = 11
        return true
    }
}`, `delegate TryDelegate(out r int32) bool;
func Outer() {
    let tryIt TryDelegate = (out r int32) -> {
        return true
    }
}`)
            yield SourceCase("GenericClassMethod", `class Holder[T] {
    func TryIt(out r int32) bool {
        r = 11
        return true
    }
}`, `class Holder[T] {
    func TryIt(out r int32) bool {
        return true
    }
}`)
            yield SourceCase("ExtensionFunction", `func (s string) TryIt(out r int32) bool {
    r = 11
    return true
}`, `func (s string) TryIt(out r int32) bool {
    return true
}`)
            yield SourceCase("StructSharedMethod", `struct Holder {
    shared {
        func TryIt(out r int32) bool {
            r = 11
            return true
        }
    }
}`, `struct Holder {
    shared {
        func TryIt(out r int32) bool {
            return true
        }
    }
}`)
            yield SourceCase("Constructor", `class Holder {
    init(out r int32) {
        r = 11
    }
}`, `class Holder {
    init(out r int32) {
    }
}`)
            yield SourceCase("PropertyGetterLambda", `delegate TryDelegate(out r int32) bool;
class Holder {
    prop Value int32 {
        get {
            let tryIt TryDelegate = (out r int32) -> {
                r = 11
                return true
            }
            return 22
        }
    }
}`, `delegate TryDelegate(out r int32) bool;
class Holder {
    prop Value int32 {
        get {
            let tryIt TryDelegate = (out r int32) -> {
                return true
            }
            return 22
        }
    }
}`)
            yield SourceCase("InterfacePropertyGetterLocalFunction", `interface IHolder {
    prop Value int32 {
        get {
            let TryIt[T] = func(out r int32) bool {
                r = 11
                return true
            }
            return 22
        }
    }
}`, `interface IHolder {
    prop Value int32 {
        get {
            let TryIt[T] = func(out r int32) bool {
                return true
            }
            return 22
        }
    }
}`)
            yield SourceCase("DeinitializerLambda", `delegate TryDelegate(out r int32) bool;
class Holder {
    deinit {
        let tryIt TryDelegate = (out r int32) -> {
            r = 11
            return true
        }
    }
}`, `delegate TryDelegate(out r int32) bool;
class Holder {
    deinit {
        let tryIt TryDelegate = (out r int32) -> {
            return true
        }
    }
}`)
            yield SourceCase("OahuChapterQueueLock", `class Holder {
    func TryIt(gate object, hasValue bool, out value int32) bool {
        lock gate {
            if hasValue {
                value = 11
                return true
            }
        }

        value = 22
        return false
    }
}`, `class Holder {
    func TryIt(gate object, hasValue bool, out value int32) bool {
        lock gate {
            if hasValue {
                return true
            }
        }

        value = 22
        return false
    }
}`)
            yield SourceCase("OahuCanWriteToDirectory", `import System

class Holder {
    shared {
        func TryIt(out error string) bool {
            try {
                error = ""
                return true
            } catch (ex Exception) {
                error = ex.Message
                return false
            }
        }
    }
}`, `import System

class Holder {
    shared {
        func TryIt(out error string) bool {
            try {
                error = ""
                return true
            } catch (ex Exception) {
                return false
            }
        }
    }
}`)
            yield SourceCase("OahuDashChunkEntries", `class Holder {
    func TryIt(limit int32, out firstLeft int32, out firstRight int32, out firstSample int32) {
        firstSample = 33
        var i = 0
        for i < limit {
            firstSample = firstSample + 1
            i = i + 1
        }

        if limit == 0 {
            firstLeft, firstRight = 44, 55
        } else {
            firstLeft = 66
            firstRight = 77
        }
    }
}`, `class Holder {
    func TryIt(limit int32, out firstLeft int32, out firstRight int32, out firstSample int32) {
        var i = 0
        for i < limit {
            firstSample = 33
            i = i + 1
        }

        if limit == 0 {
            firstLeft, firstRight = 44, 55
        } else {
            firstLeft = 66
            firstRight = 77
        }
    }
}`)
            yield SourceCase("OahuInterleavedIterator", `class Holder[T] {
    func TryIt(limit int32, out minIndex int32, out minValue T?) bool {
        minIndex = -1
        minValue = nil
        var i = 0
        for i < limit {
            if i == 22 {
                minIndex = i
                minValue = nil
                return true
            }

            i = i + 1
        }

        return false
    }
}`, `class Holder[T] {
    func TryIt(limit int32, out minIndex int32, out minValue T?) bool {
        minIndex = -1
        var i = 0
        for i < limit {
            if i == 22 {
                minIndex = i
                minValue = nil
                return true
            }

            i = i + 1
        }

        return false
    }
}`)
            yield SourceCase("OahuAllLessThanOrEqual256", `class Holder {
    unsafe func TryIt(values []int32, out checkedCount int32) bool {
        fixed p *int32 = values {
            var i = 0
            for i < 22 {
                if p[i] == 33 {
                    checkedCount = 44
                    return false
                }

                i = i + 1
            }
        }

        checkedCount = 55
        return true
    }
}`, `class Holder {
    unsafe func TryIt(values []int32, out checkedCount int32) bool {
        fixed p *int32 = values {
            var i = 0
            for i < 22 {
                if p[i] == 33 {
                    return false
                }

                i = i + 1
            }
        }

        checkedCount = 55
        return true
    }
}`)
            yield SourceCase("OahuAllLessThanOrEqual512", `class Holder {
    unsafe func TryIt(values []int32, out checkedCount int32) bool {
        fixed p *int32 = values {
            var i = 0
            for i < 33 {
                if p[i] == 44 {
                    checkedCount = 55
                    return false
                }

                i = i + 1
            }
        }

        checkedCount = 66
        return true
    }
}`, `class Holder {
    unsafe func TryIt(values []int32, out checkedCount int32) bool {
        fixed p *int32 = values {
            var i = 0
            for i < 33 {
                if p[i] == 44 {
                    return false
                }

                i = i + 1
            }
        }

        checkedCount = 66
        return true
    }
}`)
        }

        private func CallCases() sequence[SourceCase] {
            yield SourceCase("CapturedRefArgument", `delegate RefAction();
class CapturedRefHolder {
    shared {
        func Touch(ref value int32) {
            value = 11
        }

        func Run() {
            var active = 0
            let callback RefAction = () -> {
                CapturedRefHolder.Touch(&active)
            }
        }
    }
}`, `delegate RefAction();
class CapturedRefHolder {
    shared {
        func Touch(ref value int32) {
            value = 22
        }

        func Run() {
            var active int32
            let callback RefAction = () -> {
                CapturedRefHolder.Touch(&active)
            }
        }
    }
}`)
            yield SourceCase("ExplicitDefaultRefArgument", `class RefDefaultHolder {
    shared {
        func Touch(ref value int32) {
            value = 11
        }

        func Run() {
            var value = default(int32)
            RefDefaultHolder.Touch(&value)
        }
    }
}`, `class RefDefaultHolder {
    shared {
        func Touch(ref value int32) {
            value = 22
        }

        func Run() {
            var value int32
            RefDefaultHolder.Touch(&value)
        }
    }
}`)
            yield SourceCase("SharedIfElse", `class Holder {
    shared {
        func TryIt(cond bool, out r int32) bool {
            if cond {
                r = 11
            } else {
                r = 22
            }

            return true
        }
    }
}`)
            yield SourceCase("InstanceSwitch", `enum Choice { A, B }
class Holder {
    func TryIt(choice Choice, out r int32) bool {
        switch choice {
            case Choice.A { r = 22 }
            case Choice.B { r = 33 }
            default { r = 44 }
        }

        return true
    }
}`)
            yield SourceCase("DataStructEarlyReturn", `data struct Holder {
    func TryIt(cond bool, out r int32) bool {
        if cond {
            r = 33
            return true
        }

        r = 44
        return false
    }
}`)
            yield SourceCase("StructSharedLoop", `struct Holder {
    shared {
        func TryIt(limit int32, out r int32) bool {
            r = 55
            var i = 0
            for i < limit {
                r = r + 1
                i = i + 1
            }

            return true
        }
    }
}`)
            yield SourceCase("ThrowTerminatedBranch", `import System

class Holder {
    shared {
        func TryIt(cond bool, out r int32) bool {
            if cond {
                r = 11
            } else {
                throw Exception("no")
            }
            return true
        }
    }
}`)
            yield SourceCase("TryThrowTerminatedBranch", `import System

class Holder {
    shared {
        func TryIt(cond bool, out r int32) bool {
            try {
                if cond {
                    r = 22
                } else {
                    throw Exception("no")
                }
            } finally {
            }

            return true
        }
    }
}`)
            yield SourceCase("ImportedInstanceCall", `import System.Collections.Generic

class Holder {
    shared {
        func TryIt(values Dictionary[string, int32], key string, out r int32) bool {
            return values.TryGetValue(key, &r)
        }
    }
}`)
            yield SourceCase("UserStaticCall", `class Holder {
    shared {
        func Inner(out r int32) bool {
            r = 11
            return true
        }

        func TryIt(out r int32) bool {
            return Inner(&r)
        }
    }
}`)
            yield SourceCase("ConstrainedStaticCall", `interface IFill {
    shared {
        func Fill(out r int32) bool;
    }
}

func TryIt[T IFill](out r int32) bool {
    return T.Fill(&r)
}`)
            yield SourceCase("ConstructorChainingCall", `class Wrap {
    init(out r int32) {
        r = 22
    }

    convenience init(flag bool, out r int32) {
        init(&r)
    }
}`)
            yield SourceCase("ImportedStaticCall", `import System

enum Choice { A, B }
class Holder {
    shared {
        func TryIt(text string?, out choice Choice) bool {
            if text == nil {
                choice = Choice.A
                return false
            }

            return Enum.TryParse(text, true, &choice)
        }
    }
}`)
            yield SourceCase("BaseInterfaceCall", `interface IFill {
    func Fill(out r int32) bool {
        r = 33
        return true
    }
}

class Holder : IFill {
    func Fill(out r int32) bool {
        return base[IFill].Fill(&r)
    }
}`)
            yield SourceCase("ClrConversionCall", `import System

func TryIt(out r DateTime) DateTimeOffset {
    return r = DateTime.Now
}`)
            yield SourceCase("ClrConstructorCall", `import GSharp.Interpreter.Tests

func TryIt(out r int32) bool {
    let value = Issue3058OutConstructor(&r)
    return true
}`)
            yield SourceCase("UserInstanceCall", `class Holder {
    func Inner(out r int32) bool {
        r = 11
        return true
    }

    func TryIt(out r int32) bool {
        return this.Inner(&r)
    }
}`)
            yield SourceCase("IndirectDelegateCall", `delegate TryDelegate(value int32, out r int32) bool;

class Holder {
    shared {
        func Inner(value int32, out r int32) bool {
            r = value
            return true
        }

        func TryIt(out r int32) bool {
            let f TryDelegate = Inner
            return f(22, &r)
        }
    }
}`)
            yield SourceCase("ConstructorCall", `class Wrap {
    init(out r int32) {
        r = 22
    }
}

class Holder {
    shared {
        func TryIt(out r int32) bool {
            let wrapped = Wrap(&r)
            return true
        }
    }
}`)
            yield SourceCase("BaseClassCall", `open class Base {
    func Fill(out r int32) bool {
        r = 33
        return true
    }
}

class Holder : Base {
    func TryIt(out r int32) bool {
        return base.Fill(&r)
    }
}`)
            yield SourceCase("InfiniteLoop", `class Holder {
    shared {
        func NeverReturns(out r int32) {
            for {
            }
        }
    }
}`)
        }

        private func WithPositionProbe(source string, position SourcePosition) string {
            const Probe = `func PositionProbe(out value int32) {
    value = 44
}`
            let invocation = if position == SourcePosition.TopLevel {
                "var positionValue = 0\nPositionProbe(&positionValue)"
            } else {
                `func RunPositionProbe() {
    var positionValue = 0
    PositionProbe(&positionValue)
}
RunPositionProbe()`
            }
            return "$source${Environment.NewLine}$Probe${Environment.NewLine}$invocation"
        }

        private func Compile(source string, driver Issue3058OutParameterMemberDefiniteAssignmentTests.Driver)[]GSharp
            .Core
            .CodeAnalysis
            .Diagnostic {
            if driver == Issue3058OutParameterMemberDefiniteAssignmentTests.Driver.Submission {
                return EmittedOracle
                    .Evaluate(source)
                    .Diagnostics
                    .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                    .ToArray()
            }
            let compilation = Compilation(SyntaxTree.Parse(source))
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToArray()
        }
    }
}

/// CLR constructor fixture with an out parameter.
class Issue3058OutConstructor {
    /// Initializes a new instance and assigns [`value`](paramref).
    /// @param value Assigned value.
    init(out value int32) {
        value = 44
    }
}
