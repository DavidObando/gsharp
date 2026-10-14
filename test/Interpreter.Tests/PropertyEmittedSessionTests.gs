// <copyright file="PropertyEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for property.
/// Traceability: ADR-0051.
open class PropertyEmittedSessionTests {
    @Fact
    func AutoProperty_ReadWrite_OnClass() {
        let source = `class Foo {
  prop Name string
}
let f = Foo{}
f.Name = "hello"
f.Name`
        let output = RunSubmission(source)
        Assert.Contains("hello", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_DefaultValue_String() {
        // Uninitialized auto-property of type string should return empty string.
        let source = `class Foo {
  prop Name string
}
let f = Foo{}
f.Name`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_DefaultValue_Int32() {
        // Uninitialized auto-property of type int32 should return 0.
        let source = `class Foo {
  prop Count int32
}
let f = Foo{}
f.Count`
        let output = RunSubmission(source)
        Assert.Contains("0", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_ReadWrite_Int32_OnClass() {
        let source = `class Counter {
  prop Value int32
}
let c = Counter{}
c.Value = 42
c.Value`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_MultipleProperties_OnClass() {
        let source = `class Person {
  prop Name string
  prop Age int32
}
let p = Person{}
p.Name = "Alice"
p.Age = 30
p.Name`
        let output = RunSubmission(source)
        Assert.Contains("Alice", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_Reassignment_OnClass() {
        let source = `class Box {
  prop Item string
}
let b = Box{}
b.Item = "first"
b.Item = "second"
b.Item`
        let output = RunSubmission(source)
        Assert.Contains("second", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoProperty_ReadOnly_OnClass_ReturnsDefault() {
        // A get-only auto-property returns the type default.
        let source = `class Foo {
  prop Count int32 { get }
}
let f = Foo{}
f.Count`
        let output = RunSubmission(source)
        Assert.Contains("0", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func OpenProperty_Parses_Without_Error() {
        let source = `open class Base {
  open prop Label string
}
let b = Base{}
b.Label = "hi"
b.Label`
        let output = RunSubmission(source)
        Assert.Contains("hi", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func OverrideProperty_Parses_Without_Error() {
        let source = `open class Base {
  open prop Label string
}
class Derived : Base {
  override prop Label string
}
let d = Derived{}
d.Label = "derived"
d.Label`
        let output = RunSubmission(source)
        Assert.Contains("derived", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func InterfaceProperty_Parses_Without_Error() {
        let source = `interface Named {
  prop Name string { get }
}
`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func AutoPropertyInDataStruct_RoundTrips() {
        let source = `data struct P {
  var X int32
  prop Y int32
}
let p = P{Y: 7}
p.Y`
        let output = RunSubmission(source)
        Assert.Contains("7", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func ComputedProperty_Getter_ReturnsValue() {
        let source = `class Rect {
    prop Width int32
    prop Height int32
    prop Area int32 {
        get {
            return this.Width * this.Height
        }
    }
}
let r = Rect{}
r.Width = 3
r.Height = 4
r.Area`
        let output = RunSubmission(source)
        Assert.Contains("12", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func ComputedProperty_Setter_UpdatesBackingState() {
        let source = `class Counter {
    prop raw int32
    prop Value int32 {
        get {
            return this.raw * 2
        }
        set(v) {
            this.raw = v
        }
    }
}
let c = Counter{}
c.Value = 5
c.Value`
        let output = RunSubmission(source)
        Assert.Contains("10", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func ComputedProperty_GetOnly_NoSetter() {
        let source = `class Greeter {
    prop Name string
    prop Greeting string {
        get {
            return "Hello, " + this.Name
        }
    }
}
let g = Greeter{}
g.Name = "World"
g.Greeting`
        let output = RunSubmission(source)
        Assert.Contains("Hello, World", output)
        Assert.DoesNotContain("error GS", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
