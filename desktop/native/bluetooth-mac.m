// CoreBluetooth L2CAP byte carrier. Only TLS ciphertext crosses stdin/stdout.
// The QR-pinned TLS server authenticates every connection before accepting scans.
#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <signal.h>

static void emit(NSDictionary *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}

@interface Bridge : NSObject <CBPeripheralManagerDelegate, NSStreamDelegate>
@property CBPeripheralManager *manager;
@property CBUUID *serviceUUID;
@property CBL2CAPPSM psm;
@property NSMutableDictionary<NSString *, CBL2CAPChannel *> *channels;
@property NSMutableDictionary<NSString *, NSData *> *pending;
@property NSMutableDictionary<NSString *, NSNumber *> *offsets;
@property NSUInteger nextId;
- (void)start:(NSString *)identifier;
- (void)command:(NSDictionary *)command;
- (void)stop;
@end

@implementation Bridge
- (void)start:(NSString *)identifier {
    self.channels = [NSMutableDictionary dictionary];
    self.pending = [NSMutableDictionary dictionary];
    self.offsets = [NSMutableDictionary dictionary];
    self.serviceUUID = [CBUUID UUIDWithString:identifier];
    self.manager = [[CBPeripheralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()
        options:@{CBPeripheralManagerOptionShowPowerAlertKey: @NO}];
}
- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
    if (peripheral.state == CBManagerStatePoweredOn) {
        [peripheral publishL2CAPChannelWithEncryption:NO]; // TLS above the carrier provides authentication and encryption.
    } else if (peripheral.state == CBManagerStatePoweredOff || peripheral.state == CBManagerStateResetting) {
        for (NSString *identifier in self.channels.allKeys) [self close:identifier];
        self.psm = 0;
        emit(@{@"event": @"waiting", @"message": @"Turn on Bluetooth on this Mac. The connection will resume automatically."});
    } else if (peripheral.state == CBManagerStateUnauthorized || peripheral.state == CBManagerStateUnsupported) {
        emit(@{@"event": @"error", @"message": peripheral.state == CBManagerStateUnauthorized
            ? @"Allow CT45 Computer Link in System Settings → Privacy & Security → Bluetooth, then try again."
            : @"Bluetooth Low Energy is not supported by this Mac."});
    }
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral didPublishL2CAPChannel:(CBL2CAPPSM)psm error:(NSError *)error {
    if (error) { emit(@{@"event": @"error", @"message": @"Could not open a Bluetooth channel. Try enabling Bluetooth again."}); return; }
    self.psm = psm;
    uint8_t bytes[] = { (uint8_t)(psm & 255), (uint8_t)(psm >> 8) };
    CBMutableCharacteristic *characteristic = [[CBMutableCharacteristic alloc]
        initWithType:[CBUUID UUIDWithString:@"e89c1e7a-0450-4d82-9b4c-b5c3f155cf45"]
        properties:CBCharacteristicPropertyRead value:[NSData dataWithBytes:bytes length:2] permissions:CBAttributePermissionsReadable];
    CBMutableService *service = [[CBMutableService alloc] initWithType:self.serviceUUID primary:YES];
    service.characteristics = @[characteristic];
    [peripheral removeAllServices];
    [peripheral addService:service];
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral didAddService:(CBService *)service error:(NSError *)error {
    if (error) { emit(@{@"event": @"error", @"message": @"Could not advertise the Bluetooth service."}); return; }
    [peripheral startAdvertising:@{CBAdvertisementDataServiceUUIDsKey: @[self.serviceUUID], CBAdvertisementDataLocalNameKey: @"CT45 Link"}];
}
- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral error:(NSError *)error {
    if (error) emit(@{@"event": @"error", @"message": @"Could not start Bluetooth advertising. Try again."});
    else emit(@{@"event": @"ready", @"serviceId": self.serviceUUID.UUIDString.lowercaseString});
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral didOpenL2CAPChannel:(CBL2CAPChannel *)channel error:(NSError *)error {
    if (error || !channel) return;
    if (self.channels.count >= 4) { [channel.inputStream close]; [channel.outputStream close]; return; }
    NSString *identifier = [NSString stringWithFormat:@"%lu", (unsigned long)++self.nextId];
    self.channels[identifier] = channel;
    emit(@{@"event": @"open", @"id": identifier});
    channel.inputStream.delegate = self;
    channel.outputStream.delegate = self;
    [channel.inputStream scheduleInRunLoop:NSRunLoop.mainRunLoop forMode:NSDefaultRunLoopMode];
    [channel.outputStream scheduleInRunLoop:NSRunLoop.mainRunLoop forMode:NSDefaultRunLoopMode];
    [channel.inputStream open]; [channel.outputStream open];
}
- (NSString *)identifierForStream:(NSStream *)stream {
    for (NSString *identifier in self.channels) {
        CBL2CAPChannel *channel = self.channels[identifier];
        if (stream == channel.inputStream || stream == channel.outputStream) return identifier;
    }
    return nil;
}
- (void)stream:(NSStream *)stream handleEvent:(NSStreamEvent)event {
    NSString *identifier = [self identifierForStream:stream];
    if (!identifier) return;
    if (event == NSStreamEventHasBytesAvailable) {
        NSInputStream *input = self.channels[identifier].inputStream;
        uint8_t bytes[8192];
        while (input.hasBytesAvailable) {
            NSInteger count = [input read:bytes maxLength:sizeof(bytes)];
            if (count < 0) { [self close:identifier]; break; }
            if (!count) break;
            emit(@{@"event": @"data", @"id": identifier,
                @"data": [[NSData dataWithBytes:bytes length:count] base64EncodedStringWithOptions:0]});
        }
    } else if (event == NSStreamEventHasSpaceAvailable) [self drain:identifier];
    else if (event == NSStreamEventErrorOccurred || event == NSStreamEventEndEncountered) [self close:identifier];
}
- (void)drain:(NSString *)identifier {
    NSData *data = self.pending[identifier];
    if (!data) return;
    NSOutputStream *output = self.channels[identifier].outputStream;
    NSUInteger offset = [self.offsets[identifier] unsignedIntegerValue];
    while (offset < data.length && output.hasSpaceAvailable) {
        NSInteger count = [output write:((const uint8_t *)data.bytes + offset) maxLength:data.length - offset];
        if (count < 0) { [self close:identifier]; return; }
        if (!count) break;
        offset += count;
    }
    if (offset == data.length) {
        [self.pending removeObjectForKey:identifier]; [self.offsets removeObjectForKey:identifier];
        emit(@{@"event": @"written", @"id": identifier});
    } else self.offsets[identifier] = @(offset);
}
- (void)close:(NSString *)identifier {
    CBL2CAPChannel *channel = self.channels[identifier];
    if (!channel) return;
    [self.channels removeObjectForKey:identifier];
    [self.pending removeObjectForKey:identifier]; [self.offsets removeObjectForKey:identifier];
    channel.inputStream.delegate = nil; channel.outputStream.delegate = nil;
    [channel.inputStream close]; [channel.outputStream close];
    [channel.inputStream removeFromRunLoop:NSRunLoop.mainRunLoop forMode:NSDefaultRunLoopMode];
    [channel.outputStream removeFromRunLoop:NSRunLoop.mainRunLoop forMode:NSDefaultRunLoopMode];
    emit(@{@"event": @"close", @"id": identifier});
}
- (void)command:(NSDictionary *)command {
    NSString *identifier = command[@"id"];
    if (![identifier isKindOfClass:NSString.class] || !self.channels[identifier]) return;
    if ([command[@"command"] isEqual:@"close"]) [self close:identifier];
    else if ([command[@"command"] isEqual:@"write"] && [command[@"data"] isKindOfClass:NSString.class]) {
        NSData *data = [[NSData alloc] initWithBase64EncodedString:command[@"data"] options:0];
        if (!data || data.length > 65536 || self.pending[identifier]) { [self close:identifier]; return; }
        self.pending[identifier] = data; self.offsets[identifier] = @0;
        [self drain:identifier];
    }
}
- (void)stop {
    [self.manager stopAdvertising];
    [self.manager removeAllServices];
    if (self.psm) [self.manager unpublishL2CAPChannel:self.psm];
    for (NSString *identifier in self.channels.allKeys) [self close:identifier];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        if (argc != 2 || ![[NSUUID alloc] initWithUUIDString:@(argv[1])]) return 2;
        Bridge *bridge = [Bridge new]; [bridge start:@(argv[1])];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            char line[100000];
            while (fgets(line, sizeof(line), stdin)) {
                @autoreleasepool {
                    size_t length = strlen(line);
                    if (!length || line[length - 1] != '\n') break;
                    id command = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:length] options:0 error:nil];
                    if ([command isKindOfClass:NSDictionary.class]) dispatch_sync(dispatch_get_main_queue(), ^{ [bridge command:command]; });
                }
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [bridge stop]; exit(0); });
        });
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
