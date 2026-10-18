package HotReloadApp

import HotReloadBase
import System
import System.Reflection.Metadata

// Issue #4960: the failing handler is registered first, so the app handler
// shows that one handler's exception does not stop the others.
@assembly: MetadataUpdateHandler(typeof(FailingUpdateHandler))
@assembly: MetadataUpdateHandler(typeof(AppUpdateHandler))

internal class FailingUpdateHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Console.WriteLine("handler=failing phase=ClearCache")
            throw InvalidOperationException("handler-failure-probe")
        }
    }
}

internal class AppUpdateHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Console.WriteLine("handler=app phase=ClearCache types=" + Describe(updatedTypes))
        }

        func UpdateApplication(updatedTypes[]?Type) {
            let types = Describe(updatedTypes)
            Console.WriteLine("handler=app phase=UpdateApplication types=$types label=${BaseLabel.Inner.Text()}")
        }

        func Describe(updatedTypes[]?Type) string {
            if updatedTypes == nil {
                return "<nil>"
            }
            var names = ""
            for type in updatedTypes {
                if names.Length > 0 {
                    names += ","
                }
                names += type.FullName ?? type.Name
            }
            return names
        }
    }
}
