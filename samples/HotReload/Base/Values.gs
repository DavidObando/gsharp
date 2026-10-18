package HotReloadBase

class BaseValues {
    shared {
        func Current() int32 {
            return 2
        }
    }
}

class BaseLabel {
    class Inner {
        shared {
            func Text() string {
                return "label-a"
            }
        }
    }
}
