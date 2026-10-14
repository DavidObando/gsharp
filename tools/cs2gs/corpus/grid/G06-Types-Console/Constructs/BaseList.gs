// inventory: BaseList — class inheritance, virtual/override, base.M() (probe)

package Corpus.Grid06

import System

open class Animal {
    open func Speak() string {
        return "generic"
    }

    func Intro() string {
        return "animal says " + Speak()
    }
}

open class Dog : Animal {
    open override func Speak() string {
        return "woof (was " + base.Speak() + ")"
    }
}

shared class BaseListFixture {
    func Run() {
        let plain = Animal()
        let dog Animal = Dog()
        Console.WriteLine("BaseList: plain=" + plain.Speak())
        Console.WriteLine("BaseList: dog=" + dog.Speak())
        Console.WriteLine("BaseList: intro=" + dog.Intro())
    }
}
