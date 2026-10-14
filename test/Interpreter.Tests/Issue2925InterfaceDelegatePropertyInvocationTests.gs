// <copyright file="Issue2925InterfaceDelegatePropertyInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for issue #2925 source-interface delegate property invocation.
open class Issue2925InterfaceDelegatePropertyInvocationTests {
    @Fact
    func InterfaceDelegateProperties_ClassAndStruct_GetOnlyAndGetSet_Invoke() {
        let output = RunSubmission(`interface IActionBox {
    prop P System.Action[int32] { get }
}

class ClassActionBox : IActionBox {
    let Handler System.Action[int32]
    init(handler System.Action[int32]) { Handler = handler }
    prop P System.Action[int32] -> Handler
}

struct StructActionBox : IActionBox {
    prop P System.Action[int32] { get; set }
}

interface IMapper {
    prop P System.Func[int32, int32] { get; set }
}

class ClassMapper : IMapper {
    prop P System.Func[int32, int32] { get; set }
}

struct StructMapper : IMapper {
    prop P System.Func[int32, int32] { get; set }
}

let classAction IActionBox = ClassActionBox((value int32) -> Console.WriteLine(value))
classAction.P(1)

var structActionValue = StructActionBox{}
structActionValue.P = (value int32) -> Console.WriteLine(value)
let structAction IActionBox = structActionValue
structAction.P(2)

let classConcrete = ClassMapper()
classConcrete.P = (value int32) -> value + 1
let classMapper IMapper = classConcrete
Console.WriteLine(classMapper.P(41))

var structConcrete = StructMapper{}
structConcrete.P = (value int32) -> value + 2
let structMapper IMapper = structConcrete
Console.WriteLine(structMapper.P(40))`)
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}",
            output
        )
    }

    shared {
        private func RunSubmission(text string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                GSharpRepl().EvaluateSubmission(text)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
