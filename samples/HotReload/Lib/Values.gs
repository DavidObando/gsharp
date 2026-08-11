package HotReloadLib

import HotReloadBase

class Values {
    shared {
        func Current() int32 {
            return BaseValues.Current()
        }
    }
}
