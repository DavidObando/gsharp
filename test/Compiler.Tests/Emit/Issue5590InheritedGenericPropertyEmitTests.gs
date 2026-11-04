// <copyright file="Issue5590InheritedGenericPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.Loader
import Xunit

/// Regression coverage for issue #5590: inherited generic properties and fields
/// from a referenced assembly keep their receiver-substituted symbolic type.
open class Issue5590InheritedGenericPropertyEmitTests {
    @Fact
    func InheritedProtectedGenericPropertyAndField_FromReferencedAssembly_SubstituteAndVerify() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5590-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySource = `package InputLibrary

import System

public open class GrandBase[TPair any] {
    protected var pairField TPair = default(TPair)
    protected prop PairInput TPair {
        get -> pairField
        set { pairField = value }
    }
}

public open class PairBase[U any, V any] : GrandBase[(V, U)] {
}

public open class Base[TInput any] {
    private var input TInput = default(TInput)
    protected var protectedField TInput = default(TInput)
    protected event Changed Action[TInput]?

    protected open prop Input TInput {
        get -> input
        set { input = value }
    }

    protected func FireChanged(value TInput) {
        Changed?(value)
    }
}
`
            let consumerSource = `package InputConsumer

import InputLibrary
import System

data struct Big {
    var Text string
    var Other string
    var Owner ReadOnlyMemory[uint8]
    var Buffer []char
    var Busy bool
    var Source object
    var Choose Action[int32, string, string, Action[string]]
    var Done Action
    var Issue string
    var Retry Action
}

class Receiver {
    var Text string = ""
    var Matched bool
}

func TakeBig(value Big) string -> value.Text + ":" + value.Issue

open class Mid : Base[Big] {
}

open class GenericMid[U, V] : Base[(V, U)] {
}

class Owner : Base[Big] {
    private let configure Action[Receiver]

    init() {
        Input = Big {
            Text: "alpha",
            Other: "beta",
            Owner: default(ReadOnlyMemory[uint8]),
            Buffer: []char{'x'},
            Busy: true,
            Source: "src",
            Choose: (a int32, b string, c string, d Action[string]) -> {},
            Done: () -> {},
            Issue: "5590",
            Retry: () -> {}
        }
        protectedField = Input
        configure = receiver -> {
            if Input is Big value {
                receiver.Text = value.Text + "/" + this.Input.Issue + "/" + base.Input.Other + "/" + protectedField.Text
                receiver.Matched = true
            }
        }
    }

    func Read() string {
        let receiver = Receiver()
        configure(receiver)
        let direct = TakeBig(Input) + "|" + TakeBig(this.Input) + "|" + TakeBig(base.Input)
        base.Input = Big {
            Text: "updated",
            Other: "beta",
            Owner: default(ReadOnlyMemory[uint8]),
            Buffer: []char{'y'},
            Busy: false,
            Source: "src",
            Choose: (a int32, b string, c string, d Action[string]) -> {},
            Done: () -> {},
            Issue: "ok",
            Retry: () -> {}
        }
        this.protectedField = base.Input
        var eventLog = ""
        this.Changed += (v Big) -> { eventLog = eventLog + v.Text }
        Changed += (v Big) -> { eventLog = eventLog + ":" + v.Issue }
        FireChanged(base.Input)
        return (receiver.Matched ? "correct branch" : "wrong branch") +
            ":" + receiver.Text +
            ":" + direct +
            ":" + this.protectedField.Text +
            ":" + eventLog
    }
}

class MidOwner : Mid {
    init() {
        this.Input = Big {
            Text: "mid",
            Other: "o",
            Owner: default(ReadOnlyMemory[uint8]),
            Buffer: []char{},
            Busy: false,
            Source: "s",
            Choose: (a int32, b string, c string, d Action[string]) -> {},
            Done: () -> {},
            Issue: "m1",
            Retry: () -> {}
        }
    }

    func Check() string -> TakeBig(Input)
}

class GenericMidOwner : GenericMid[int32, Big] {
    init() {
        let b = Big {
            Text: "reordered",
            Other: "o",
            Owner: default(ReadOnlyMemory[uint8]),
            Buffer: []char{},
            Busy: false,
            Source: "s",
            Choose: (a int32, b string, c string, d Action[string]) -> {},
            Done: () -> {},
            Issue: "g1",
            Retry: () -> {}
        }
        Input = (b, 7)
    }

    func Check() string {
        let (big, num) = Input
        return TakeBig(big) + "#" + num.ToString()
    }
}

class ImportedHierarchyOwner : PairBase[int32, Big] {
    init() {
        let b = Big {
            Text: "pair",
            Other: "o",
            Owner: default(ReadOnlyMemory[uint8]),
            Buffer: []char{},
            Busy: false,
            Source: "s",
            Choose: (a int32, b string, c string, d Action[string]) -> {},
            Done: () -> {},
            Issue: "p1",
            Retry: () -> {}
        }
        PairInput = (b, 9)
    }

    func Check() string {
        let (big, num) = PairInput
        let (fieldBig, fieldNum) = pairField
        return TakeBig(big) + "#" + num.ToString() + "=" + TakeBig(fieldBig) + "#" + fieldNum.ToString()
    }
}

public func RunAll() string {
    return Owner().Read() +
        ";" + MidOwner().Check() +
        ";" + GenericMidOwner().Check() +
        ";" + ImportedHierarchyOwner().Check()
}
`
            let libraryPath = CompileAssembly(
                directory,
                "InputLibrary",
                librarySource,
                isLibrary: true,
                Array.Empty[string]()
            )
            let consumerPath = CompileAssembly(
                directory,
                "InputConsumer",
                consumerSource,
                isLibrary: true,
                []string{libraryPath}
            )
            let loadContext = AssemblyLoadContext("Issue5590", isCollectible: true)
            try {
                using let libraryStream = MemoryStream(File.ReadAllBytes(libraryPath))
                using let consumerStream = MemoryStream(File.ReadAllBytes(consumerPath))
                let _ = loadContext.LoadFromStream(libraryStream)
                let consumer = loadContext.LoadFromStream(consumerStream)
                let ownerType = consumer.GetType("InputConsumer.Owner", throwOnError: true)!!
                let bigType = consumer.GetType("InputConsumer.Big", throwOnError: true)!!
                let receiverType = consumer.GetType("InputConsumer.Receiver", throwOnError: true)!!
                let invoke = ownerType
                    .GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic)
                    .SelectMany(
                    (nested Type) -> nested.GetMethods(
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    )
                )
                    .Single(
                    (method MethodInfo) -> method.Name.Contains("Invoke", StringComparison.Ordinal) &&
                        method
                        .GetParameters().Length == 1 && method.GetParameters()[0].ParameterType == receiverType
                )
                let methodBody = invoke.GetMethodBody()!!
                Assert.Contains(methodBody.LocalVariables, (local LocalVariableInfo) -> local.LocalType == bigType)
                let instructions = IlInstructionReader.Read(methodBody.GetILAsByteArray()!!)
                Assert.NotEmpty(instructions)
                Assert.Contains(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Box)
                let program = consumer.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let runAll = program.GetMethod(
                    "RunAll",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!
                let actual = Assert.IsType[string](runAll.Invoke(nil, nil))
                Assert.Equal(
                    "correct branch:alpha/5590/beta/alpha:alpha:5590|alpha:5590|alpha:5590:updated:updated:ok;mid:m1;reordered:g1#7;pair:p1#9=pair:p1#9",
                    actual
                )
            } finally {
                loadContext.Unload()
            }
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ExactIssue5590Repro_LambdaPatternMatchOnInheritedProtectedGenericProperty_VerifiesAndRuns() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5590-repro-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySource = `package InputLibrary

public open class Base[TInput any] {
    private var input TInput = default(TInput)
    protected prop Input TInput { get -> input }
}
`
            let consumerSource = `package InputConsumer

import InputLibrary
import System

data struct Big {
    var Text string
    var Other string
    var Owner ReadOnlyMemory[uint8]
    var Buffer []char
    var Busy bool
    var Source object
    var Choose Action[int32, string, string, Action[string]]
    var Done Action
    var Issue string
    var Retry Action
}

class Receiver {
    var Text string = ""
    var Matched bool
}

public class Owner : Base[Big] {
    private let configure Action[Receiver]

    public init() {
        configure = receiver -> {
            if Input is Big value {
                receiver.Text = value.Text
                receiver.Matched = true
            }
        }
    }

    public func Read() string {
        let receiver = Receiver()
        configure(receiver)
        return receiver.Matched ? "correct branch" : "wrong branch"
    }
}
`
            let libraryPath = CompileAssembly(
                directory,
                "InputLibrary",
                librarySource,
                isLibrary: true,
                Array.Empty[string]()
            )
            let consumerPath = CompileAssembly(
                directory,
                "InputConsumer",
                consumerSource,
                isLibrary: true,
                []string{libraryPath}
            )
            let loadContext = AssemblyLoadContext("Issue5590Repro", isCollectible: true)
            try {
                using let libraryStream = MemoryStream(File.ReadAllBytes(libraryPath))
                using let consumerStream = MemoryStream(File.ReadAllBytes(consumerPath))
                let _ = loadContext.LoadFromStream(libraryStream)
                let consumer = loadContext.LoadFromStream(consumerStream)
                let ownerType = consumer.GetType("InputConsumer.Owner", throwOnError: true)!!
                let ownerInstance = Activator.CreateInstance(ownerType)!!
                let readMethod = ownerType.GetMethod("Read")!!
                Assert.Equal("correct branch", readMethod.Invoke(ownerInstance, nil))
            } finally {
                loadContext.Unload()
            }
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileAssembly(
            directory string,
            name string,
            source string,
            isLibrary bool,
            references IReadOnlyList[string]
        ) string {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let target = if isLibrary {
                "/target:library"
            } else {
                "/target:exe"
            }
            let arguments = List[string]{"/out:" + outputPath, target, "/targetframework:net10.0"}
            for reference in references {
                arguments.Add("/r:" + reference)
            }
            arguments.Add(sourcePath)
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var exitCode int32
            try {
                exitCode = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exitCode == 0, "gsc failed (${exitCode}):\n${stdoutWriter}\n${stderrWriter}")
            Assert.True(File.Exists(outputPath))
            IlVerifier.Verify(outputPath, additionalReferences: references)
            return outputPath
        }
    }
}
