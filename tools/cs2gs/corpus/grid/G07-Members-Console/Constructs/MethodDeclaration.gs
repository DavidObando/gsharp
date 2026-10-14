// inventory: MethodDeclaration — instance, static, virtual/override, and `new` hiding (probe)

package Corpus.Grid07

import System

open class Speaker {
    open func Voice() string {
        return "base-voice"
    }

    func Twice() string {
        return Voice() + "+" + Voice()
    }

    func Label() string {
        return "speaker"
    }
}

open class LoudSpeaker : Speaker {
    open override func Voice() string {
        return "LOUD"
    }

    func Label() string {
        return "loudspeaker"
    }
}

shared class MethodDeclarationFixture {
    func Add(left int32, right int32) int32 {
        return left + right
    }

    func Run() {
        Console.WriteLine("MethodDeclaration: static=" + Add(19, 23).ToString())
        let loud = LoudSpeaker()
        let asBase Speaker = loud
        Console.WriteLine("MethodDeclaration: virtual=" + asBase.Voice())
        Console.WriteLine("MethodDeclaration: twice=" + asBase.Twice())
        Console.WriteLine("MethodDeclaration: hide-base=" + asBase.Label())
        Console.WriteLine("MethodDeclaration: hide-derived=" + loud.Label())
    }
}
