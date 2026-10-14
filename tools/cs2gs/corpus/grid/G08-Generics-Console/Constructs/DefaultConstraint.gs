// inventory: DefaultConstraint — where T : default on an override

package Corpus.Grid08

import System

abstract class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower : MaybeShower {
    override func Show[T](value T?) string {
        return if value == nil {
            "null"
        } else {
            "value"
        }
    }
}

shared class DefaultConstraintFixture {
    func Run() {
        let shower MaybeShower = PlainShower()
        Console.WriteLine("DefaultConstraint: string=" + shower.Show("x"))
        Console.WriteLine("DefaultConstraint: null=" + shower.Show[string](nil))
    }
}
