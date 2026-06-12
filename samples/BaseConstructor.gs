// file: BaseConstructor.gs
// Issue #306: a GSharp `class` can invoke a specific base-class constructor via
// the `: Base(args)` initializer that follows the base type name. This unlocks
// inheriting from base classes that lack a parameterless constructor (e.g. many
// BCL types such as System.Exception). The base-constructor arguments may
// reference the derived class's primary-constructor parameters.
//
// This sample proves the full scenario end-to-end:
//   * a GSharp class inherits a CLR base whose only ctor takes arguments
//   * the base ctor receives forwarded, type-converted arguments
//   * inherited base state (Exception.Message) reflects the forwarded value
//   * a GSharp base with a primary constructor is chained the same way
//   * base-ctor arguments can be arbitrary expressions over the primary params

package GSharp.Example.BaseConstructor

import System

// `MyError` extends System.Exception, whose accessible constructors all require
// arguments. The primary-constructor parameter `Detail` is forwarded to the
// base `Exception(string)` ctor, so the inherited `Message` property is set.
class MyError(Detail string) : Exception(Detail) {
}

var e = MyError("boom")
Console.WriteLine(e.Message)
Console.WriteLine(e.Detail)

// A base-constructor argument may be an arbitrary expression over the primary
// parameters rather than a bare parameter reference.
class LabeledError(Label string) : Exception(Label + "!") {
}

var le = LabeledError("warn")
Console.WriteLine(le.Message)

// A GSharp base class with its own primary constructor is chained identically.
open class Animal(Name string) {
    func Speak() string {
        return Name
    }
}

class Dog(Pet string) : Animal(Pet) {
}

var d = Dog("Rex")
Console.WriteLine(d.Speak())
Console.WriteLine(d.Name)
