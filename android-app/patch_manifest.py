"""Run by the workflow after `cap add android`: registers the notification service/receiver and the mailto/share filters."""
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'xmlns:tools' not in s:
    s = s.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ', 1)
app = ('<service android:name=".MailMessagingService" android:exported="false">'
       '<intent-filter android:priority="100"><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter></service>'
       '<service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService" tools:node="remove"/>'
       '<receiver android:name=".MailActionReceiver" android:exported="false"/>')
s = s.replace('</application>', app + '</application>', 1)
flt = ('<intent-filter><action android:name="android.intent.action.SENDTO"/><category android:name="android.intent.category.DEFAULT"/>'
       '<category android:name="android.intent.category.BROWSABLE"/><data android:scheme="mailto"/></intent-filter>'
       '<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/>'
       '<category android:name="android.intent.category.BROWSABLE"/><data android:scheme="mailto"/></intent-filter>'
       '<intent-filter><action android:name="android.intent.action.SEND"/><category android:name="android.intent.category.DEFAULT"/>'
       '<data android:mimeType="text/plain"/></intent-filter>')
s = s.replace('</activity>', flt + '</activity>', 1)
assert 'MailMessagingService' in s and 'mailto' in s
open(p, 'w', encoding='utf-8').write(s)
