// inventory: BaseConstructorInitializer — derived constructor chaining : base(...)

package Corpus.Grid07

import System

open class VehicleBase {
    private let _kind string

    init(kind string) {
        _kind = kind
    }

    func Kind() string {
        return _kind
    }
}

open class Truck : VehicleBase {
    private let _wheels int32

    init(wheels int32) : base("truck") {
        _wheels = wheels
    }

    func Wheels() int32 {
        return _wheels
    }
}

shared class BaseConstructorInitializerFixture {
    func Run() {
        let truck = Truck(6)
        Console.WriteLine("BaseConstructorInitializer: kind=" + truck.Kind() + " wheels=" + truck.Wheels().ToString())
    }
}
