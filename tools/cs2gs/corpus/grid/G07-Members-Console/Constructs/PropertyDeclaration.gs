// inventory: PropertyDeclaration — auto get/set, get-only, computed (arrow), private set

package Corpus.Grid07

import System

open class Thermostat {
    init(room string) {
        Room = room
        Target = 20
    }

    prop Target int32

    prop Room string {
        get;
    }

    prop TargetPlusOne int32 -> Target + 1

    prop Adjustments int32 {
        get;
        private set;
    }

    func Nudge(delta int32) {
        Target = Target + delta
        Adjustments = Adjustments + 1
    }
}

shared class PropertyDeclarationFixture {
    func Run() {
        let stat = Thermostat("study")
        stat.Target = 22
        stat.Nudge(3)
        Console.WriteLine("PropertyDeclaration: room=" + stat.Room)
        Console.WriteLine("PropertyDeclaration: target=" + stat.Target.ToString())
        Console.WriteLine("PropertyDeclaration: computed=" + stat.TargetPlusOne.ToString())
        Console.WriteLine("PropertyDeclaration: adjustments=" + stat.Adjustments.ToString())
    }
}
