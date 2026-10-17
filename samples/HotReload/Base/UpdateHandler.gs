package HotReloadBase

import System
import System.Reflection.Metadata

// Issue #4960: a handler in a transitive dependency runs before the
// handlers of the assemblies that reference it, in both phases.
@assembly: MetadataUpdateHandler(typeof(BaseUpdateHandler))

internal class BaseUpdateHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Console.WriteLine("handler=base phase=ClearCache types=" + Describe(updatedTypes))
        }

        func UpdateApplication(updatedTypes[]?Type) {
            Console.WriteLine("handler=base phase=UpdateApplication types=" + Describe(updatedTypes))
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
