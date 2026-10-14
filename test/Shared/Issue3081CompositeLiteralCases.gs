// <copyright file="Issue3081CompositeLiteralCases.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System
import System.Globalization
import System.IO

internal shared class Issue3081CompositeLiteralCases {
    const Controls string = `package Issue3081Controls
import System

open class Base[T] {
    var inherited int32
    var shadowed int32
    prop inheritedProperty int32 { get; set; }
}

class Derived[T] : Base[T] {
    var own int32
    var shadowed int32
}

struct Value[T] {
    var own int32
}

func RunControls() {
    let localValue = Value[int32]{ own: 555 }
    Console.WriteLine(localValue.own)
    let localOwn = Derived[int32]{ own: 566 }
    Console.WriteLine(localOwn.own)
    let localShadowed = Derived[int32]{ shadowed: 577 }
    Console.WriteLine(localShadowed.shadowed)
}

let own = Derived[string]{ own: 511 }
Console.WriteLine(own.own)
let shadowed = Derived[string]{ shadowed: 522 }
Console.WriteLine(shadowed.shadowed)
let value = Value[string]{ own: 533 }
Console.WriteLine(value.own)
let property = Derived[string]{ inheritedProperty: 544 }
Console.WriteLine(property.inheritedProperty)
RunControls()`

    let ControlsOutput string = "511${Environment.NewLine}522${Environment.NewLine}533${Environment.NewLine}544${Environment.NewLine}555${Environment.NewLine}566${Environment.NewLine}577${Environment.NewLine}"

    const ObjectInitializer string = `package Issue3081ObjectInitializer
import System

open class Base[T] {
    var inherited int32
}

class Derived[T] : Base[T] {
}

let value = Derived[string]() { inherited = 611 }
Console.WriteLine(value.inherited)`

    let ObjectInitializerOutput string = "611${Environment.NewLine}"

    const Lowering string = `package Issue3081Lowering
import System

open class Base {
    var inherited int32
}

class Derived[T] : Base {
    prop source int32 { get; set; }

    func Build() Derived[T] {
        return Derived[T]{ inherited: source }
    }
}

let owner = Derived[string]() { source = 711 }
Console.WriteLine(owner.Build().inherited)`

    let LoweringOutput string = "711${Environment.NewLine}"

    const AsyncSpill string = `package Issue3081AsyncSpill
import System
import System.Threading.Tasks

open class Base {
    var inherited int32
}

class Derived[T] : Base {
}

async func Build() Derived[string] {
    return Derived[string]{ inherited: await Task.FromResult(811) }
}

let value = Build().Result
Console.WriteLine(value.inherited)`

    let AsyncSpillOutput string = "811${Environment.NewLine}"

    func BuildMatrixSource(inFunction bool) string {
        var body = `let forwardedOwn = Forwarded[string]{ own: OFFSET11 }
Console.WriteLine(forwardedOwn.own)
let forwardedShadowed = Forwarded[string]{ shadowed: OFFSET12 }
Console.WriteLine(forwardedShadowed.shadowed)
let forwardedInherited = Forwarded[string]{ inherited: OFFSET13 }
Console.WriteLine(forwardedInherited.inherited)

let closedOwn = Closed[int32]{ own: OFFSET21 }
Console.WriteLine(closedOwn.own)
let closedShadowed = Closed[int32]{ shadowed: OFFSET22 }
Console.WriteLine(closedShadowed.shadowed)
let closedInherited = Closed[int32]{ inherited: OFFSET23 }
Console.WriteLine(closedInherited.inherited)

let plainOwn = Plain[string]{ own: OFFSET31 }
Console.WriteLine(plainOwn.own)
let plainShadowed = Plain[string]{ shadowed: OFFSET32 }
Console.WriteLine(plainShadowed.shadowed)
let plainInherited = Plain[string]{ inherited: OFFSET33 }
Console.WriteLine(plainInherited.inherited)`
        let offset = if inFunction {
            200
        } else {
            100
        }
        for var tens = 1; tens <= 3; tens++ {
            for var ones = 1; ones <= 3; ones++ {
                body = body.Replace(
                    "OFFSET$tens$ones",
                    (offset + (tens * 10) + ones).ToString(CultureInfo.InvariantCulture),
                    StringComparison.Ordinal
                )
            }
        }
        if inFunction {
            body = "func RunMatrix() {\n" + Indent(body) + `}

RunMatrix()
`
        }
        return `package Issue3081Matrix
import System

open class ForwardBase[T] {
    var inherited int32
    var shadowed int32
}

class Forwarded[T] : ForwardBase[T] {
    var own int32
    var shadowed int32
}

open class ClosedBase[T] {
    var inherited int32
    var shadowed int32
}

class Closed[T] : ClosedBase[string] {
    var own int32
    var shadowed int32
}

open class PlainBase {
    var inherited int32
    var shadowed int32
}

class Plain[T] : PlainBase {
    var own int32
    var shadowed int32
}
` + body
    }

    func BuildMatrixOutput(offset int32) string {
        using let writer = StringWriter()
        for var tens = 1; tens <= 3; tens++ {
            for var ones = 1; ones <= 3; ones++ {
                writer.WriteLine(offset + (tens * 10) + ones)
            }
        }
        return writer.ToString().ReplaceLineEndings(Environment.NewLine)
    }

    private func Indent(text string) string -> "    " + text.Replace("\n", "\n    ", StringComparison.Ordinal)
}
